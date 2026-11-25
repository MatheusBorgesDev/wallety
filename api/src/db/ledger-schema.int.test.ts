import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { resetDb, disconnectDb } from "../test/db.js";

// These tests bypass the application on purpose: they write SQL directly to prove
// that the database itself refuses an inconsistent ledger.

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function createUserAccount(currency = "BRL") {
  const sandbox = await prisma.sandbox.create({ data: { kind: "DEMO" } });
  const user = await prisma.user.create({
    data: { sandboxId: sandbox.id, displayName: "Test user" },
  });
  return prisma.account.create({
    data: { name: "Main", currency, userId: user.id, sandboxId: sandbox.id },
  });
}

async function systemAccount(currency = "BRL") {
  return prisma.account.findFirstOrThrow({ where: { kind: "SYSTEM", currency } });
}

async function insertTransfer(tx: Tx, scope = "system", key: string = randomUUID()) {
  const id = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "transfers" ("id", "idempotencyScope", "idempotencyKey", "requestHash")
    VALUES (${id}, ${scope}, ${key}, 'hash')`;
  return id;
}

async function insertEntry(tx: Tx, transferId: string, accountId: string, amount: bigint, currency = "BRL") {
  await tx.$executeRaw`
    INSERT INTO "ledger_entries" ("id", "transferId", "accountId", "amount", "currency")
    VALUES (${randomUUID()}, ${transferId}, ${accountId}, ${amount}, ${currency})`;
}

async function insertBalancedTransfer(tx: Tx, fromId: string, toId: string, amount: bigint) {
  const transferId = await insertTransfer(tx);
  await insertEntry(tx, transferId, fromId, -amount);
  await insertEntry(tx, transferId, toId, amount);
  return transferId;
}

async function globalSum() {
  const [row] = await prisma.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum("amount")::bigint AS total FROM "ledger_entries"`;
  return row?.total ?? 0n;
}

describe("ledger schema guarantees", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("seeds one SYSTEM account per supported currency", async () => {
    const systems = await prisma.account.findMany({ where: { kind: "SYSTEM" }, orderBy: { currency: "asc" } });
    expect(systems.map((account) => account.currency)).toEqual(["BRL", "USD"]);
  });

  it("accepts a transfer whose entries sum to zero", async () => {
    const system = await systemAccount();
    const account = await createUserAccount();

    await prisma.$transaction((tx) => insertBalancedTransfer(tx, system.id, account.id, 1000n));

    expect(await prisma.ledgerEntry.count()).toBe(2);
    expect(await globalSum()).toBe(0n);
  });

  it("rejects, at commit, a transfer whose entries do not sum to zero", async () => {
    const system = await systemAccount();
    const account = await createUserAccount();

    const unbalanced = prisma.$transaction(async (tx) => {
      const transferId = await insertTransfer(tx);
      await insertEntry(tx, transferId, system.id, -1000n);
      await insertEntry(tx, transferId, account.id, 999n);
    });

    await expect(unbalanced).rejects.toThrow(/not balanced/);
    expect(await prisma.transfer.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it("rejects a transfer with a single entry", async () => {
    const account = await createUserAccount();

    const singleEntry = prisma.$transaction(async (tx) => {
      const transferId = await insertTransfer(tx);
      await insertEntry(tx, transferId, account.id, 1000n);
    });

    await expect(singleEntry).rejects.toThrow(/not balanced/);
  });

  it("rejects a transfer committed without entries", async () => {
    await expect(prisma.$transaction((tx) => insertTransfer(tx))).rejects.toThrow(/not balanced/);
  });

  it("rejects an entry with a zero amount", async () => {
    const system = await systemAccount();
    const zero = prisma.$transaction(async (tx) => {
      const transferId = await insertTransfer(tx);
      await insertEntry(tx, transferId, system.id, 0n);
    });

    await expect(zero).rejects.toThrow(/ledger_entries_amount_nonzero/);
  });

  it("rejects an entry in a currency different from its account", async () => {
    const system = await systemAccount("BRL");
    const mismatch = prisma.$transaction(async (tx) => {
      const transferId = await insertTransfer(tx);
      await insertEntry(tx, transferId, system.id, -1000n, "USD");
    });

    await expect(mismatch).rejects.toThrow(/does not match account currency/);
  });

  it("rejects a second SYSTEM account for a currency", async () => {
    await expect(
      prisma.account.create({ data: { kind: "SYSTEM", name: "Another BRL", currency: "BRL" } }),
    ).rejects.toThrow();
  });

  it("rejects a USER account without an owner and a SYSTEM account with one", async () => {
    await expect(prisma.account.create({ data: { name: "Orphan", currency: "BRL" } })).rejects.toThrow();

    const owned = await createUserAccount();
    await expect(
      prisma.account.create({
        data: { kind: "SYSTEM", name: "Owned", currency: "EUR", userId: owned.userId, sandboxId: owned.sandboxId },
      }),
    ).rejects.toThrow();
  });

  it("keeps idempotency keys unique per scope, not globally", async () => {
    const system = await systemAccount();
    const account = await createUserAccount();
    const insert = (scope: string) =>
      prisma.$transaction(async (tx) => {
        const transferId = await insertTransfer(tx, scope, "same-key");
        await insertEntry(tx, transferId, system.id, -100n);
        await insertEntry(tx, transferId, account.id, 100n);
      });

    await insert("user-a");
    await insert("user-b");

    await expect(insert("user-a")).rejects.toThrow();
    expect(await prisma.transfer.count()).toBe(2);
  });

  describe("as the API role (wallety_app)", () => {
    it("can append a balanced transfer", async () => {
      const system = await systemAccount();
      const account = await createUserAccount();

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE wallety_app`);
        await insertBalancedTransfer(tx, system.id, account.id, 500n);
      });

      expect(await prisma.ledgerEntry.count()).toBe(2);
    });

    it.each([
      [`UPDATE "ledger_entries" SET "amount" = "amount" * 2`],
      [`DELETE FROM "ledger_entries"`],
      [`UPDATE "transfers" SET "requestHash" = 'tampered'`],
      [`DELETE FROM "transfers"`],
      [`DELETE FROM "accounts"`],
    ])("cannot run: %s", async (statement) => {
      const system = await systemAccount();
      const account = await createUserAccount();
      await prisma.$transaction((tx) => insertBalancedTransfer(tx, system.id, account.id, 500n));

      const attempt = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE wallety_app`);
        await tx.$executeRawUnsafe(statement);
      });

      await expect(attempt).rejects.toThrow(/permission denied/);
      expect(await prisma.ledgerEntry.count()).toBe(2);
    });
  });

  describe("as the cleanup role (wallety_purge)", () => {
    it("can remove a whole transfer, leaving the ledger balanced", async () => {
      const system = await systemAccount();
      const account = await createUserAccount();
      const transferId = await prisma.$transaction((tx) =>
        insertBalancedTransfer(tx, system.id, account.id, 500n),
      );

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE wallety_purge`);
        await tx.$executeRaw`DELETE FROM "ledger_entries" WHERE "transferId" = ${transferId}`;
        await tx.$executeRaw`DELETE FROM "transfers" WHERE "id" = ${transferId}`;
      });

      expect(await prisma.transfer.count()).toBe(0);
      expect(await globalSum()).toBe(0n);
    });

    it("cannot remove one side of a transfer", async () => {
      const system = await systemAccount();
      const account = await createUserAccount();
      await prisma.$transaction((tx) => insertBalancedTransfer(tx, system.id, account.id, 500n));

      const halfPurge = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE wallety_purge`);
        await tx.$executeRaw`DELETE FROM "ledger_entries" WHERE "accountId" = ${account.id}`;
      });

      await expect(halfPurge).rejects.toThrow(/not balanced/);
      expect(await prisma.ledgerEntry.count()).toBe(2);
    });

    it("cannot insert or change anything", async () => {
      const attempt = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE wallety_purge`);
        await insertTransfer(tx);
      });

      await expect(attempt).rejects.toThrow(/permission denied/);
    });
  });
});
