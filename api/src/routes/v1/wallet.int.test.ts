import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "../../db/prisma.js";
import { bearer, createTestApp, postTransfer, registerWithWallet } from "../../test/api.js";
import { resetDb, disconnectDb } from "../../test/db.js";
import { globalSum } from "../../test/fixtures.js";

const app = createTestApp();

describe("accounts", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("lists my accounts with the balance derived from the ledger, as a string of cents", async () => {
    const user = await registerWithWallet(app);

    const res = await request(app).get("/v1/accounts").set(bearer(user));

    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([
      { id: user.accountId, name: "Main", currency: "BRL", balance: "100000", createdAt: expect.any(String) },
    ]);
    const one = await request(app).get(`/v1/accounts/${user.accountId}`).set(bearer(user));
    expect(one.body).toEqual(res.body.accounts[0]);
  });

  it("opens an empty account in a currency the ledger can issue", async () => {
    const user = await registerWithWallet(app);

    const opened = await request(app).post("/v1/accounts").set(bearer(user)).send({ name: " Savings ", currency: "USD" });

    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ name: "Savings", currency: "USD", balance: "0" });
    const list = await request(app).get("/v1/accounts").set(bearer(user));
    expect(list.body.accounts.map((account: { name: string }) => account.name)).toEqual(["Main", "Savings"]);
  });

  it("refuses a currency without a system account and more than five accounts, simultaneous requests included", async () => {
    const user = await registerWithWallet(app);
    const open = (currency: string) => request(app).post("/v1/accounts").set(bearer(user)).send({ name: "Extra", currency });

    const unsupported = await open("EUR");
    expect([unsupported.status, unsupported.body.error.code]).toEqual([422, "unsupported_currency"]);

    const attempts = await Promise.all(Array.from({ length: 8 }, () => open("BRL")));
    expect(attempts.filter((res) => res.status === 201)).toHaveLength(4);
    const refused = attempts.filter((res) => res.status !== 201);
    expect(refused).toHaveLength(4);
    expect(new Set(refused.map((res) => res.body.error.code))).toEqual(new Set(["account_limit_reached"]));
    expect(await prisma.account.count({ where: { userId: user.userId } })).toBe(5);
  });

  it("answers a malformed id with a validation error, not a server error", async () => {
    const user = await registerWithWallet(app);
    const res = await request(app).get("/v1/accounts/not-a-uuid").set(bearer(user));
    expect([res.status, res.body.error.code]).toEqual([400, "validation_error"]);
  });
});

describe("transfers", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("moves money to a recipient and shows both sides of the transfer", async () => {
    const user = await registerWithWallet(app);

    const res = await postTransfer(app, user, {
      fromAccountId: user.accountId,
      toAccountId: user.recipientAccountId,
      amount: "2550",
    });

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.body).toEqual({
      id: expect.any(String),
      status: "POSTED",
      createdAt: expect.any(String),
      entries: [
        { accountId: user.accountId, amount: "-2550", currency: "BRL" },
        { accountId: user.recipientAccountId, amount: "2550", currency: "BRL" },
      ],
    });
    const account = await request(app).get(`/v1/accounts/${user.accountId}`).set(bearer(user));
    expect(account.body.balance).toBe("97450");
    const fetched = await request(app).get(`/v1/transfers/${res.body.id}`).set(bearer(user));
    expect(fetched.body).toEqual(res.body);
    expect(await globalSum()).toBe(0n);
  });

  it("a double click moves the money once: the same key returns the original transfer, marked as a replay", async () => {
    const user = await registerWithWallet(app);
    const body = { fromAccountId: user.accountId, toAccountId: user.recipientAccountId, amount: "1000" };

    const [first, second] = await Promise.all([
      postTransfer(app, user, body, "double-click"),
      postTransfer(app, user, body, "double-click"),
    ]);
    const third = await postTransfer(app, user, body, "double-click");

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(third.status).toBe(200);
    expect(third.headers["idempotent-replayed"]).toBe("true");
    expect(new Set([first.body.id, second.body.id, third.body.id]).size).toBe(1);
    const account = await request(app).get(`/v1/accounts/${user.accountId}`).set(bearer(user));
    expect(account.body.balance).toBe("99000");
    expect(await prisma.outboxEvent.count()).toBe(2);
  });

  it("refuses the same key with a different body", async () => {
    const user = await registerWithWallet(app);
    const body = { fromAccountId: user.accountId, toAccountId: user.recipientAccountId, amount: "1000" };
    await postTransfer(app, user, body, "reused");

    const res = await postTransfer(app, user, { ...body, amount: "9999" }, "reused");

    expect([res.status, res.body.error.code]).toEqual([422, "idempotency_key_reuse"]);
  });

  it("requires the Idempotency-Key header", async () => {
    const user = await registerWithWallet(app);
    const res = await request(app)
      .post("/v1/transfers")
      .set(bearer(user))
      .send({ fromAccountId: user.accountId, toAccountId: user.recipientAccountId, amount: "1" });
    expect([res.status, res.body.error.code]).toEqual([400, "validation_error"]);
    expect(res.body.error.details[0]).toMatchObject({ in: "headers", path: "idempotency-key" });
  });

  it("refuses a transfer larger than the balance and writes nothing", async () => {
    const user = await registerWithWallet(app);
    const transfers = await prisma.transfer.count();

    const res = await postTransfer(app, user, {
      fromAccountId: user.accountId,
      toAccountId: user.recipientAccountId,
      amount: "100001",
    });

    expect([res.status, res.body.error.code]).toEqual([422, "insufficient_funds"]);
    expect(await prisma.transfer.count()).toBe(transfers);
  });

  it.each([
    ["a number instead of a string", 100],
    ["a decimal", "10.50"],
    ["zero", "0"],
    ["a negative value", "-5"],
    ["more digits than the ledger stores", "1".repeat(19)],
  ])("refuses an amount that is %s", async (_label, amount) => {
    const user = await registerWithWallet(app);
    const res = await postTransfer(app, user, {
      fromAccountId: user.accountId,
      toAccountId: user.recipientAccountId,
      amount: amount as string,
    });
    expect([res.status, res.body.error.code]).toEqual([400, "validation_error"]);
  });

  it("refuses the same account on both sides and accounts in different currencies", async () => {
    const user = await registerWithWallet(app);
    const usd = await request(app).post("/v1/accounts").set(bearer(user)).send({ name: "Dollars", currency: "USD" });

    const same = await postTransfer(app, user, { fromAccountId: user.accountId, toAccountId: user.accountId, amount: "1" });
    const mixed = await postTransfer(app, user, { fromAccountId: user.accountId, toAccountId: usd.body.id, amount: "1" });

    expect([same.status, same.body.error.code]).toEqual([422, "same_account"]);
    expect([mixed.status, mixed.body.error.code]).toEqual([422, "currency_mismatch"]);
  });

  it("does not let a user pay into the system account, and answers as if it did not exist", async () => {
    const user = await registerWithWallet(app);
    const system = await prisma.account.findFirstOrThrow({ where: { kind: "SYSTEM", currency: "BRL" } });

    const res = await postTransfer(app, user, { fromAccountId: user.accountId, toAccountId: system.id, amount: "1" });

    expect([res.status, res.body.error.code]).toEqual([404, "account_not_found"]);
  });

  it("tells the delivery process after a posted transfer, not after a replay, and survives its failure", async () => {
    let notifications = 0;
    const notifying = createTestApp({
      notifyDispatcher: async () => {
        notifications += 1;
        throw new Error("delivery process unreachable");
      },
    });
    const user = await registerWithWallet(notifying);
    const body = { fromAccountId: user.accountId, toAccountId: user.recipientAccountId, amount: "10" };

    const posted = await postTransfer(notifying, user, body, "notify-once");
    const replayed = await postTransfer(notifying, user, body, "notify-once");

    expect([posted.status, replayed.status]).toEqual([201, 200]);
    expect(notifications).toBe(1);
  });
});

describe("statement", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("lists entries newest first, with the other side of each, the opening balance included", async () => {
    const user = await registerWithWallet(app);
    await postTransfer(app, user, { fromAccountId: user.accountId, toAccountId: user.recipientAccountId, amount: "300" });

    const res = await request(app).get(`/v1/accounts/${user.accountId}/entries`).set(bearer(user));

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.entries).toMatchObject([
      { amount: "-300", currency: "BRL", counterparty: { accountId: user.recipientAccountId, name: "Main", kind: "USER" } },
      { amount: "100000", currency: "BRL", counterparty: { accountId: null, kind: "SYSTEM" } },
    ]);
  });

  it("pages through every entry exactly once with the cursor", async () => {
    const user = await registerWithWallet(app);
    for (let index = 1; index <= 6; index += 1) {
      await postTransfer(app, user, {
        fromAccountId: user.accountId,
        toAccountId: user.recipientAccountId,
        amount: String(index),
      });
    }
    // Entries written in the same millisecond must still be ordered and not skipped.
    await prisma.$executeRaw`UPDATE "ledger_entries" SET "createdAt" = '2026-01-01T00:00:00Z' WHERE "amount" IN (-2, -3, -4)`;

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await request(app)
        .get(`/v1/accounts/${user.accountId}/entries`)
        .query({ limit: 3, ...(cursor ? { cursor } : {}) })
        .set(bearer(user));
      expect(res.status).toBe(200);
      expect(res.body.entries.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.entries.map((entry: { amount: string }) => entry.amount));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual(["-1", "-2", "-3", "-4", "-5", "-6", "100000"].sort());
    expect(new Set(seen).size).toBe(7);
  });

  it("refuses a cursor it did not issue", async () => {
    const user = await registerWithWallet(app);
    const res = await request(app).get(`/v1/accounts/${user.accountId}/entries`).query({ cursor: "bm9wZQ" }).set(bearer(user));
    expect([res.status, res.body.error.code]).toEqual([400, "invalid_cursor"]);
  });
});

describe("webhook events", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("shows each event of my sandbox with its delivery state and what the receiver recorded", async () => {
    const user = await registerWithWallet(app);
    const transfer = await postTransfer(app, user, {
      fromAccountId: user.accountId,
      toAccountId: user.recipientAccountId,
      amount: "5",
    });
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { transferId: transfer.body.id } });
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "DELIVERED", attempts: 2, deliveredAt: new Date(), lastError: "HTTP 503" },
    });
    await prisma.webhookReceipt.create({
      data: { eventId: event.id, sandboxId: event.sandboxId, type: event.type, firstAttempt: 2 },
    });

    const res = await request(app).get("/v1/webhook-events").set(bearer(user));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toEqual({
      id: event.id,
      type: "transfer.posted",
      transferId: transfer.body.id,
      status: "DELIVERED",
      attempts: 2,
      nextAttemptAt: null,
      lastError: "HTTP 503",
      deliveredAt: expect.any(String),
      createdAt: expect.any(String),
      receipt: { receivedAt: expect.any(String), firstAttempt: 2, deliveries: 1 },
    });
    expect(res.body.events[1]).toMatchObject({ status: "PENDING", attempts: 0, receipt: null });
    expect(JSON.stringify(res.body)).not.toContain("payload");
  });

  it("sets how many deliveries the receiver refuses, within bounds", async () => {
    const user = await registerWithWallet(app);
    const { sandboxId } = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

    const set = await request(app).post("/v1/webhook-receiver/failures").set(bearer(user)).send({ failures: 2 });
    const tooMany = await request(app).post("/v1/webhook-receiver/failures").set(bearer(user)).send({ failures: 6 });

    expect([set.status, set.body]).toEqual([200, { failures: 2 }]);
    expect(tooMany.status).toBe(400);
    expect((await prisma.sandbox.findUniqueOrThrow({ where: { id: sandboxId } })).receiverFailuresLeft).toBe(2);
  });
});
