import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../db/prisma.js";
import { createOutboxStore } from "../infra/db/outbox-store.js";
import { createPessimisticLedger } from "../infra/db/pessimistic-ledger.js";
import { createHttpTransport } from "../infra/webhooks/http-transport.js";
import { createLogger } from "../observability/logger.js";
import { resetDb, disconnectDb } from "../test/db.js";
import { createSandbox, createUserWithAccount, fund } from "../test/fixtures.js";
import { drain } from "../webhooks/dispatcher.js";
import { signPayload } from "../webhooks/signature.js";

const signingSecret = "test-signing-secret-with-enough-length";
const ledger = createPessimisticLedger(prisma);
const app = createApp({ logger: createLogger({ level: "silent" }) });

async function postedEvent() {
  const sandbox = await createSandbox();
  const { account } = await createUserWithAccount(sandbox.id);
  await fund(ledger, account.id, 100n);
  return prisma.outboxEvent.findFirstOrThrow();
}

function deliver(event: { id: string; payload: string }, options: { attempt?: number; signature?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return request(app)
    .post("/webhooks/receiver")
    .set("Content-Type", "application/json")
    .set("Wallety-Event-Id", event.id)
    .set("Wallety-Delivery-Attempt", String(options.attempt ?? 1))
    .set("Wallety-Signature", options.signature ?? signPayload(signingSecret, now, event.payload))
    .send(event.payload);
}

describe("built-in webhook receiver", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("accepts a correctly signed delivery and records it", async () => {
    const event = await postedEvent();

    const response = await deliver(event);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: false });
    expect(await prisma.webhookReceipt.findMany()).toMatchObject([
      { eventId: event.id, sandboxId: event.sandboxId, type: "transfer.posted", firstAttempt: 1, deliveries: 1 },
    ]);
  });

  it("deduplicates by event id: a repeated delivery is acknowledged and stored once", async () => {
    const event = await postedEvent();

    await deliver(event, { attempt: 1 });
    const repeated = await deliver(event, { attempt: 2 });

    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({ received: true, duplicate: true });
    expect(await prisma.webhookReceipt.findMany()).toMatchObject([
      { eventId: event.id, firstAttempt: 1, deliveries: 2 },
    ]);
  });

  it("rejects a delivery whose body was changed after signing", async () => {
    const event = await postedEvent();
    const signature = signPayload(signingSecret, Math.floor(Date.now() / 1000), event.payload);
    const tampered = { id: event.id, payload: event.payload.replace('"100"', '"999"') };

    const response = await deliver(tampered, { signature });

    expect(response.status).toBe(401);
    expect(await prisma.webhookReceipt.count()).toBe(0);
  });

  it("rejects a delivery signed with another secret, a missing signature and an old timestamp", async () => {
    const event = await postedEvent();
    const now = Math.floor(Date.now() / 1000);

    const wrongSecret = await deliver(event, {
      signature: signPayload("another-secret-with-enough-length!!", now, event.payload),
    });
    const missing = await deliver(event, { signature: "" });
    const stale = await deliver(event, { signature: signPayload(signingSecret, now - 3600, event.payload) });

    expect([wrongSecret.status, missing.status, stale.status]).toEqual([401, 401, 401]);
    expect(await prisma.webhookReceipt.count()).toBe(0);
  });

  it("refuses the next deliveries of a sandbox when asked to simulate failures", async () => {
    const event = await postedEvent();
    await prisma.sandbox.update({ where: { id: event.sandboxId }, data: { receiverFailuresLeft: 2 } });

    const statuses = [
      (await deliver(event, { attempt: 1 })).status,
      (await deliver(event, { attempt: 2 })).status,
      (await deliver(event, { attempt: 3 })).status,
    ];

    expect(statuses).toEqual([503, 503, 200]);
    expect(await prisma.webhookReceipt.findMany()).toMatchObject([{ eventId: event.id, firstAttempt: 3, deliveries: 1 }]);
    expect((await prisma.sandbox.findUniqueOrThrow({ where: { id: event.sandboxId } })).receiverFailuresLeft).toBe(0);
  });

  it("answers 400 to a signed body that is not an event", async () => {
    const body = "not json";
    const response = await request(app)
      .post("/webhooks/receiver")
      .set("Content-Type", "application/json")
      .set("Wallety-Signature", signPayload(signingSecret, Math.floor(Date.now() / 1000), body))
      .send(body);

    expect(response.status).toBe(400);
  });

  it("end to end: the delivery process retries until the receiver accepts", async () => {
    const event = await postedEvent();
    await prisma.sandbox.update({ where: { id: event.sandboxId }, data: { receiverFailuresLeft: 2 } });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    // The clock starts at the real time so the receiver accepts the signature timestamp,
    // and it only moves forward when the fake sleep is called.
    let clock = new Date(Date.now() + 1000);

    try {
      const summary = await drain(
        {
          store: createOutboxStore(prisma),
          transport: createHttpTransport(),
          targetUrl: `http://127.0.0.1:${port}/webhooks/receiver`,
          signingSecret,
          now: () => clock,
        },
        {
          maxDurationMs: 60_000,
          sleep: async (ms) => {
            clock = new Date(clock.getTime() + ms);
          },
        },
      );

      expect(summary).toEqual({ delivered: 1, retried: 2, failed: 0 });
      expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
        status: "DELIVERED",
        attempts: 3,
      });
      expect(await prisma.webhookReceipt.findMany()).toMatchObject([
        { eventId: event.id, firstAttempt: 3, deliveries: 1 },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
