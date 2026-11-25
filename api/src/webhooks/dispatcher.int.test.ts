import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "../db/prisma.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { createOutboxStore } from "../infra/db/outbox-store.js";
import { createPessimisticLedger } from "../infra/db/pessimistic-ledger.js";
import { createHttpTransport } from "../infra/webhooks/http-transport.js";
import { resetDb, disconnectDb } from "../test/db.js";
import { createSandbox, createUserWithAccount, fund } from "../test/fixtures.js";
import { startReceiverDouble } from "../test/webhook-receiver-double.js";
import { dispatchDue, drain, type DispatcherDeps } from "./dispatcher.js";
import { verifySignature } from "./signature.js";

const signingSecret = "test-signing-secret-with-enough-length";
const ledger = createPessimisticLedger(prisma);

// The delivery process connects with its own login, which can only read the outbox
// and update delivery state. Running the tests through it proves the code needs no more.
const dispatcherUrl = new URL(process.env.DATABASE_URL!);
dispatcherUrl.username = "wallety_dispatcher";
dispatcherUrl.password = "wallety_dispatcher";
const dispatcherPrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: dispatcherUrl.toString() }),
});
const store = createOutboxStore(dispatcherPrisma);

type Receiver = Awaited<ReturnType<typeof startReceiverDouble>>;
let receiver: Receiver;
// A controlled clock, started ahead of the database clock so new events are already due.
let clock: Date;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

function deps(overrides: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    store,
    transport: createHttpTransport({ timeoutMs: 2000 }),
    targetUrl: receiver.url,
    signingSecret,
    now: () => clock,
    ...overrides,
  };
}

// Every funding transfer writes one event to the outbox.
async function postTransfers(count: number) {
  const sandbox = await createSandbox();
  const { account } = await createUserWithAccount(sandbox.id);
  for (let index = 0; index < count; index += 1) {
    await fund(ledger, account.id, 100n);
  }
}

async function onlyEvent() {
  return prisma.outboxEvent.findFirstOrThrow();
}

describe("webhook delivery", () => {
  beforeEach(async () => {
    await resetDb();
    receiver = await startReceiverDouble();
    clock = new Date(Date.now() + 60_000);
  });
  afterEach(() => receiver.close());
  afterAll(async () => {
    await dispatcherPrisma.$disconnect();
    await disconnectDb();
  });

  it("delivers a pending event with its id, attempt number and a valid signature", async () => {
    await postTransfers(1);
    const event = await onlyEvent();

    const summary = await dispatchDue(deps());

    expect(summary).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(receiver.deliveries).toHaveLength(1);
    const delivery = receiver.deliveries[0]!;
    expect(delivery.body).toBe(event.payload);
    expect(delivery.headers["wallety-event-id"]).toBe(event.id);
    expect(delivery.headers["wallety-event-type"]).toBe("transfer.posted");
    expect(delivery.headers["wallety-delivery-attempt"]).toBe("1");
    expect(
      verifySignature({
        secret: signingSecret,
        header: delivery.headers["wallety-signature"] as string,
        body: delivery.body,
        nowSeconds: Math.floor(clock.getTime() / 1000),
      }),
    ).toEqual({ valid: true });
    expect(await onlyEvent()).toMatchObject({ status: "DELIVERED", attempts: 1, lastError: null });
    expect((await onlyEvent()).deliveredAt).toEqual(clock);
  });

  it("delivers again after failures, following the backoff, with the same event id", async () => {
    await postTransfers(1);
    const event = await onlyEvent();
    receiver.respondWith(500, 503);

    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect(await onlyEvent()).toMatchObject({ status: "PENDING", attempts: 1, lastError: "HTTP 500" });

    // Not due yet: nothing is sent before the backoff elapses.
    advance(999);
    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(receiver.deliveries).toHaveLength(1);

    advance(1);
    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 1, failed: 0 });
    advance(1999);
    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 0, failed: 0 });
    advance(1);
    expect(await dispatchDue(deps())).toEqual({ delivered: 1, retried: 0, failed: 0 });

    expect(receiver.deliveries.map((delivery) => delivery.headers["wallety-event-id"])).toEqual([
      event.id,
      event.id,
      event.id,
    ]);
    expect(receiver.deliveries.map((delivery) => delivery.headers["wallety-delivery-attempt"])).toEqual(["1", "2", "3"]);
    expect(new Set(receiver.deliveries.map((delivery) => delivery.body))).toEqual(new Set([event.payload]));
    expect(await onlyEvent()).toMatchObject({ status: "DELIVERED", attempts: 3, lastError: null });
  });

  it("gives up after the last attempt and keeps the error", async () => {
    await postTransfers(1);
    receiver.respondWith(500, 500, 500, 500, 500, 500, 500);

    const summaries = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      summaries.push(await dispatchDue(deps()));
      advance(60_000);
    }

    expect(summaries.slice(0, 5)).toEqual(Array(5).fill({ delivered: 0, retried: 1, failed: 0 }));
    expect(summaries[5]).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(await onlyEvent()).toMatchObject({ status: "FAILED", attempts: 6, lastError: "HTTP 500" });

    advance(3_600_000);
    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(receiver.deliveries).toHaveLength(6);
  });

  it("delivers each event once when two delivery processes run at the same time", async () => {
    await postTransfers(10);

    const [first, second] = await Promise.all([dispatchDue(deps()), dispatchDue(deps())]);

    expect(first.delivered + second.delivered).toBe(10);
    const ids = receiver.deliveries.map((delivery) => delivery.headers["wallety-event-id"]);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("does not wait for rows another delivery process holds: it takes the rest", async () => {
    await postTransfers(3);
    const [held] = await prisma.outboxEvent.findMany({ take: 1 });

    // Another process is in the middle of claiming one event: its row is locked.
    const claimedMeanwhile = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "outbox_events" WHERE "id" = ${held!.id} FOR UPDATE`;
        return store.claimDue({ now: clock, limit: 10, leaseMs: 30_000 });
      },
      { timeout: 3000 },
    );

    expect(claimedMeanwhile).toHaveLength(2);
    expect(claimedMeanwhile.map((event) => event.id)).not.toContain(held!.id);
  });

  it("delivers again, with the same id, when a process dies before recording the outcome", async () => {

    await postTransfers(1);
    const event = await onlyEvent();

    // Claim the event the way a delivery process would, then never record what happened.
    await store.claimDue({ now: clock, limit: 10, leaseMs: 30_000 });

    advance(29_999);
    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 0, failed: 0 });
    advance(1);
    expect(await dispatchDue(deps())).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(receiver.deliveries[0]!.headers["wallety-event-id"]).toBe(event.id);
    expect(receiver.deliveries[0]!.headers["wallety-delivery-attempt"]).toBe("2");
  });

  it("treats an unreachable receiver as a failed attempt", async () => {
    await postTransfers(1);
    await receiver.close();

    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await onlyEvent()).lastError).toMatch(/^network error/);
  });

  it("treats a receiver that does not answer in time as a failed attempt", async () => {
    await postTransfers(1);
    receiver.neverAnswer();

    const summary = await dispatchDue(deps({ transport: createHttpTransport({ timeoutMs: 150 }) }));

    expect(summary).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await onlyEvent()).lastError).toBe("timeout after 150 ms");
  });

  it("does not follow redirects", async () => {
    await postTransfers(1);
    receiver.respondWith(302);

    expect(await dispatchDue(deps())).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await onlyEvent()).lastError).toBe("HTTP 302");
    expect(receiver.deliveries).toHaveLength(1);
  });

  it("drains in one wake-up: waits for each retry and stops when nothing is pending", async () => {
    await postTransfers(1);
    receiver.respondWith(500, 500);
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      advance(ms);
    };

    const summary = await drain(deps(), { maxDurationMs: 60_000, sleep });

    expect(summary).toEqual({ delivered: 1, retried: 2, failed: 0 });
    expect(waits).toEqual([1000, 2000]);
    expect(await onlyEvent()).toMatchObject({ status: "DELIVERED", attempts: 3 });
  });

  it("stops draining when the next retry falls outside its time budget", async () => {
    await postTransfers(1);
    receiver.respondWith(500, 500, 500);
    const sleep = async (ms: number) => advance(ms);

    const summary = await drain(deps(), { maxDurationMs: 2500, sleep });

    expect(summary).toEqual({ delivered: 0, retried: 2, failed: 0 });
    expect(await onlyEvent()).toMatchObject({ status: "PENDING", attempts: 2 });
  });

  it("runs with a database login that cannot read the ledger", async () => {
    await postTransfers(1);

    await expect(dispatcherPrisma.ledgerEntry.count()).rejects.toThrow(/permission denied/);
    await expect(dispatcherPrisma.account.count()).rejects.toThrow(/permission denied/);
  });
});
