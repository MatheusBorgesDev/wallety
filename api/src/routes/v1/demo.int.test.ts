import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "../../db/prisma.js";
import type { Purger } from "../../infra/db/purge.js";
import { createPurger } from "../../infra/db/purge.js";
import {
  bearer,
  createTestApp,
  postTransfer,
  registerWithWallet,
  relaxedRateLimits,
  startDemo,
  TEST_PASSWORD,
} from "../../test/api.js";
import { resetDb, disconnectDb, rowsOfSandbox } from "../../test/db.js";
import { balanceOf, globalSum, systemAccount } from "../../test/fixtures.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const purgeSecret = "test-purge-secret-with-enough-length-01";
const purger = createPurger(process.env.PURGE_DATABASE_URL!);

const sandboxOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).sandboxId;

function clockedApp(start: string, options: Parameters<typeof createTestApp>[0] = {}) {
  const clock = { now: new Date(start) };
  return { clock, app: createTestApp({ now: () => clock.now, ...options }) };
}

describe("demo entry", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("signs a visitor in with no credentials, for exactly as long as the sandbox lives", async () => {
    const { app } = clockedApp("2026-03-01T12:00:00Z");

    const res = await request(app).post("/v1/auth/demo");

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      user: { id: expect.any(String), email: null, displayName: "Demo user" },
      accessToken: expect.any(String),
      tokenType: "Bearer",
      expiresAt: "2026-03-02T12:00:00.000Z",
      sandboxExpiresAt: "2026-03-02T12:00:00.000Z",
    });
    const me = await request(app).get("/v1/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.body.sandbox).toEqual({ kind: "DEMO", expiresAt: "2026-03-02T12:00:00.000Z" });
    expect(me.body.session).toEqual({ expiresAt: "2026-03-02T12:00:00.000Z" });
  });

  it("the opening balance is a ledger entry that comes from the system account, and nothing else holds money", async () => {
    const app = createTestApp();
    const demo = await startDemo(app);
    const system = await systemAccount();

    const statement = await request(app).get(`/v1/accounts/${demo.accountId}/entries`).set(bearer(demo));

    expect(statement.body.entries).toHaveLength(1);
    expect(statement.body.entries[0]).toMatchObject({
      amount: "100000",
      counterparty: { accountId: null, name: "System BRL", kind: "SYSTEM" },
    });
    // The balance is that one entry; the system account carries the other side; no other
    // account in the database has a balance at all.
    expect(await balanceOf(demo.accountId)).toBe(100_000n);
    expect(await balanceOf(system.id)).toBe(-100_000n);
    expect(await balanceOf(demo.recipientAccountId)).toBe(0n);
    expect(await prisma.ledgerEntry.count()).toBe(2);
    expect(await globalSum()).toBe(0n);
  });

  it("a demo user moves money inside its sandbox and nowhere else", async () => {
    const app = createTestApp();
    const demo = await startDemo(app);
    const otherDemo = await startDemo(app);
    const registered = await registerWithWallet(app);

    const inside = await postTransfer(app, demo, {
      fromAccountId: demo.accountId,
      toAccountId: demo.recipientAccountId,
      amount: "500",
    });
    expect(inside.status).toBe(201);

    for (const target of [otherDemo.accountId, otherDemo.recipientAccountId, registered.accountId]) {
      const outside = await postTransfer(app, demo, { fromAccountId: demo.accountId, toAccountId: target, amount: "500" });
      expect([outside.status, outside.body.error.code]).toEqual([404, "account_not_found"]);
    }
    expect(await balanceOf(demo.accountId)).toBe(99_500n);
    expect(await balanceOf(otherDemo.accountId)).toBe(100_000n);
    expect(await balanceOf(registered.accountId)).toBe(100_000n);
  });

  it("refuses the token the moment the sandbox expires, while its rows are still there", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger: null });
    const demo = await startDemo(app);

    clock.now = new Date("2026-03-02T11:59:59Z");
    expect((await request(app).get("/v1/accounts").set(bearer(demo))).status).toBe(200);

    clock.now = new Date("2026-03-02T12:00:00Z");
    const refused = await request(app).get("/v1/accounts").set(bearer(demo));
    const transfer = await postTransfer(app, demo, {
      fromAccountId: demo.accountId,
      toAccountId: demo.recipientAccountId,
      amount: "1",
    });

    expect(refused.status).toBe(401);
    expect(transfer.status).toBe(401);
    expect(await rowsOfSandbox(await sandboxOf(demo.userId))).toMatchObject({ sandboxes: 1, users: 2, accounts: 2 });
    expect(await balanceOf(demo.accountId)).toBe(100_000n);
  });

  it("refuses the token when only the sandbox has expired, even if the token itself has not", async () => {
    const app = createTestApp({ purger: null });
    const demo = await startDemo(app);
    await prisma.sandbox.update({ where: { id: await sandboxOf(demo.userId) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get("/v1/me").set(bearer(demo))).status).toBe(401);
  });

  it("limits demos per address", async () => {
    const app = createTestApp({ authRateLimits: { ...relaxedRateLimits, demoPerIp: { limit: 2, windowSeconds: 3600 } } });
    await startDemo(app);
    await startDemo(app);

    const blocked = await request(app).post("/v1/auth/demo");

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(await prisma.sandbox.count()).toBe(2);
  });

  it("stops at the cap of demo sandboxes; registered users do not count towards it", async () => {
    const app = createTestApp({ maxDemoSandboxes: 2, purger: null });
    await registerWithWallet(app);
    await startDemo(app);
    await startDemo(app);

    const full = await request(app).post("/v1/auth/demo");

    expect([full.status, full.body.error.code]).toEqual([503, "demo_capacity_reached"]);
    expect(full.headers["retry-after"]).toBe("600");
    expect(await prisma.sandbox.count({ where: { kind: "DEMO" } })).toBe(2);
  });

  it("makes room by removing expired demos before it counts", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { maxDemoSandboxes: 2, purger });
    await startDemo(app);
    await startDemo(app);

    clock.now = new Date("2026-03-02T12:05:00Z");
    const next = await request(app).post("/v1/auth/demo");

    expect(next.status).toBe(201);
    expect(await prisma.sandbox.count({ where: { kind: "DEMO" } })).toBe(1);
  });
});

describe("cleanup of expired sandboxes", () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await purger.disconnect();
    await disconnectDb();
  });

  it("removes every row of an expired demo; the ledger sums to zero and the system account is back where it was", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger: null });
    const survivor = await registerWithWallet(app);
    const system = await systemAccount();
    const systemBefore = await balanceOf(system.id);
    const counts = async () => ({
      transfers: await prisma.transfer.count(),
      entries: await prisma.ledgerEntry.count(),
      events: await prisma.outboxEvent.count(),
      receipts: await prisma.webhookReceipt.count(),
    });
    const before = await counts();

    const demo = await startDemo(app);
    const sandboxId = await sandboxOf(demo.userId);
    const transfer = await postTransfer(app, demo, {
      fromAccountId: demo.accountId,
      toAccountId: demo.recipientAccountId,
      amount: "2500",
    });
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { transferId: transfer.body.id } });
    await prisma.webhookReceipt.create({ data: { eventId: event.id, sandboxId, type: event.type, firstAttempt: 1 } });
    expect(await balanceOf(system.id)).toBe(systemBefore - 100_000n);

    clock.now = new Date("2026-03-02T12:02:00Z");
    const summary = await purger.purge({ now: clock.now, maxSandboxes: 50 });

    expect(summary.sandboxes).toBe(1);
    expect(await rowsOfSandbox(sandboxId)).toEqual({ sandboxes: 0, users: 0, accounts: 0, outboxEvents: 0, webhookReceipts: 0 });
    expect(await prisma.transfer.findUnique({ where: { id: transfer.body.id } })).toBeNull();
    expect(await counts()).toEqual(before);
    expect(await globalSum()).toBe(0n);
    expect(await balanceOf(system.id)).toBe(systemBefore);
    // The neighbour is untouched.
    expect(await balanceOf(survivor.accountId)).toBe(100_000n);
    expect((await request(app).get("/v1/accounts").set(bearer(demo))).status).toBe(401);
  });

  it("leaves a demo alone until it has expired, and for a minute after", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger: null });
    const demo = await startDemo(app);
    const sandboxId = await sandboxOf(demo.userId);

    for (const moment of ["2026-03-02T11:59:00Z", "2026-03-02T12:00:30Z"]) {
      clock.now = new Date(moment);
      expect((await purger.purge({ now: clock.now, maxSandboxes: 50 })).sandboxes).toBe(0);
    }
    expect((await rowsOfSandbox(sandboxId)).sandboxes).toBe(1);

    clock.now = new Date("2026-03-02T12:01:01Z");
    expect((await purger.purge({ now: clock.now, maxSandboxes: 50 })).sandboxes).toBe(1);
  });

  it("removes a registered user after 30 days without signing in, and keeps one who signed in", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger: null });
    const idle = await registerWithWallet(app);
    const active = await registerWithWallet(app);
    const idleSandbox = await sandboxOf(idle.userId);
    const activeSandbox = await sandboxOf(active.userId);
    // Rows are stamped by the database clock; move them to the test's timeline.
    await prisma.user.updateMany({ data: { createdAt: clock.now } });

    clock.now = new Date(clock.now.getTime() + 20 * DAY);
    await request(app).post("/v1/auth/login").send({ email: active.email, password: TEST_PASSWORD });

    clock.now = new Date(new Date("2026-03-01T12:00:00Z").getTime() + 30 * DAY - HOUR);
    expect((await purger.purge({ now: clock.now, maxSandboxes: 50 })).sandboxes).toBe(0);

    clock.now = new Date(new Date("2026-03-01T12:00:00Z").getTime() + 30 * DAY + HOUR);
    expect((await purger.purge({ now: clock.now, maxSandboxes: 50 })).sandboxes).toBe(1);
    expect((await rowsOfSandbox(idleSandbox)).sandboxes).toBe(0);
    expect((await rowsOfSandbox(activeSandbox)).sandboxes).toBe(1);
    expect(await globalSum()).toBe(0n);
  });

  it("removes at most the number of sandboxes it was asked to, oldest first", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger: null });
    const first = await startDemo(app);
    await startDemo(app);
    await startDemo(app);

    clock.now = new Date("2026-03-03T00:00:00Z");
    const summary = await purger.purge({ now: clock.now, maxSandboxes: 2 });

    expect(summary.sandboxes).toBe(2);
    expect(await prisma.sandbox.count()).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: first.userId } })).toBeNull();
  });

  it("drops rate-limit windows older than a day and keeps recent ones", async () => {
    const now = new Date("2026-03-10T12:00:00Z");
    await prisma.rateLimitHit.createMany({
      data: [
        { key: "old", windowStart: new Date("2026-03-09T11:00:00Z") },
        { key: "recent", windowStart: new Date("2026-03-10T11:00:00Z") },
      ],
    });

    const summary = await purger.purge({ now, maxSandboxes: 50 });

    expect(summary.rateLimitWindows).toBe(1);
    expect((await prisma.rateLimitHit.findMany()).map((hit) => hit.key)).toEqual(["recent"]);
  });

  it("runs on a login that can delete but cannot insert or change anything", async () => {
    const app = createTestApp({ purger: null });
    const demo = await startDemo(app);
    const { PrismaClient } = await import("../../generated/prisma/client.js");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const asPurger = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.PURGE_DATABASE_URL! }) });
    try {
      const [who] = await asPurger.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      expect(who!.current_user).toBe("wallety_purger");
      await expect(
        asPurger.$executeRaw`UPDATE "ledger_entries" SET "amount" = "amount" * 2 WHERE "accountId" = ${demo.accountId}`,
      ).rejects.toThrow(/permission denied/);
      await expect(asPurger.sandbox.create({ data: { kind: "DEMO" } })).rejects.toThrow(/permission denied/);
      await expect(
        asPurger.$executeRaw`UPDATE "sandboxes" SET "expiresAt" = now() WHERE "id" = ${await sandboxOf(demo.userId)}`,
      ).rejects.toThrow(/permission denied/);
    } finally {
      await asPurger.$disconnect();
    }
  });
});

describe("POST /internal/purge", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  function spiedPurger() {
    const calls: { now: Date; maxSandboxes: number }[] = [];
    const spy: Purger = {
      purge: async (options) => {
        calls.push(options);
        return { sandboxes: 3, rateLimitWindows: 7 };
      },
      disconnect: async () => {},
    };
    return { calls, spy };
  }

  it("is refused without the secret, with a wrong one and with another scheme, before the cleanup is touched", async () => {
    const { calls, spy } = spiedPurger();
    const app = createTestApp({ purger: spy });

    const answers = await Promise.all([
      request(app).post("/internal/purge"),
      request(app).post("/internal/purge").set("Authorization", `Bearer ${purgeSecret}x`),
      request(app).post("/internal/purge").set("Authorization", `Bearer ${purgeSecret.slice(0, -1)}`),
      request(app).post("/internal/purge").set("Authorization", `Basic ${purgeSecret}`),
      request(app).post("/internal/purge").set("Authorization", purgeSecret),
    ]);

    expect(answers.map((res) => res.status)).toEqual([401, 401, 401, 401, 401]);
    expect(calls).toEqual([]);
  });

  it("runs the cleanup with the secret and reports what was removed", async () => {
    const { calls, spy } = spiedPurger();
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger: spy });

    const res = await request(app).post("/internal/purge").set("Authorization", `Bearer ${purgeSecret}`);

    expect([res.status, res.body]).toEqual([200, { sandboxes: 3, rateLimitWindows: 7 }]);
    expect(calls).toEqual([{ now: clock.now, maxSandboxes: 200 }]);
  });

  it("removes an expired demo end to end, on the real cleanup login", async () => {
    const { app, clock } = clockedApp("2026-03-01T12:00:00Z", { purger });
    const demo = await startDemo(app);
    const sandboxId = await sandboxOf(demo.userId);

    clock.now = new Date("2026-03-02T13:00:00Z");
    const res = await request(app).post("/internal/purge").set("Authorization", `Bearer ${purgeSecret}`);

    expect([res.status, res.body.sandboxes]).toEqual([200, 1]);
    expect((await rowsOfSandbox(sandboxId)).sandboxes).toBe(0);
    expect(await globalSum()).toBe(0n);
  });

  it("does not exist when no cleanup is configured, and is not in the API document", async () => {
    const without = createTestApp({ purger: null });
    const withCleanup = createTestApp();

    expect((await request(without).post("/internal/purge").set("Authorization", `Bearer ${purgeSecret}`)).status).toBe(404);
    const document = await request(withCleanup).get("/openapi.json");
    expect(JSON.stringify(document.body)).not.toContain("/internal");
  });
});
