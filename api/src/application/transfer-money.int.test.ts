import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db/prisma.js";
import { CrossSandboxTransfer, InsufficientFunds } from "../domain/errors.js";
import { createPessimisticLedger } from "../infra/db/pessimistic-ledger.js";
import { resetDb, disconnectDb } from "../test/db.js";
import {
  balanceOf,
  createSandbox,
  createUserWithAccount,
  fund,
  globalSum,
  systemAccount,
} from "../test/fixtures.js";
import { AccountNotFound, IdempotencyKeyReuse } from "./errors.js";
import type { Ledger } from "./ledger.js";
import { transferMoney } from "./transfer-money.js";

const ledger = createPessimisticLedger(prisma);

// A ledger whose unit of work fails after the use case did everything, right before commit.
const ledgerThatFailsBeforeCommit: Ledger = {
  transaction: (work) =>
    ledger.transaction(async (tx) => {
      await work(tx);
      throw new Error("connection lost before commit");
    }),
};

async function twoUsersInOneSandbox() {
  const sandbox = await createSandbox();
  const alice = await createUserWithAccount(sandbox.id);
  const bob = await createUserWithAccount(sandbox.id);
  return { alice, bob };
}

describe("transferMoney", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("moves money between two accounts; balances are derived from the ledger", async () => {
    const { alice, bob } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 1000n);

    const result = await transferMoney(ledger, {
      actor: { type: "user", userId: alice.user.id },
      fromAccountId: alice.account.id,
      toAccountId: bob.account.id,
      amount: 300n,
      idempotencyKey: "key-1",
    });

    expect(result.replayed).toBe(false);
    expect(await balanceOf(alice.account.id)).toBe(700n);
    expect(await balanceOf(bob.account.id)).toBe(300n);
    expect(await globalSum()).toBe(0n);
  });

  it("funding leaves the system account negative by exactly the amount issued", async () => {
    const { alice } = await twoUsersInOneSandbox();
    const system = await systemAccount();

    await fund(ledger, alice.account.id, 2500n);

    expect(await balanceOf(system.id)).toBe(-2500n);
    expect(await balanceOf(alice.account.id)).toBe(2500n);
    expect(await globalSum()).toBe(0n);
  });

  it("rejects a transfer larger than the balance and writes nothing", async () => {
    const { alice, bob } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 100n);
    const transfersBefore = await prisma.transfer.count();

    const attempt = transferMoney(ledger, {
      actor: { type: "user", userId: alice.user.id },
      fromAccountId: alice.account.id,
      toAccountId: bob.account.id,
      amount: 101n,
      idempotencyKey: "key-1",
    });

    await expect(attempt).rejects.toThrow(InsufficientFunds);
    expect(await prisma.transfer.count()).toBe(transfersBefore);
    expect(await balanceOf(alice.account.id)).toBe(100n);
  });

  it("replays a repeated request: same key and payload return the original transfer", async () => {
    const { alice, bob } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 1000n);
    const command = {
      actor: { type: "user", userId: alice.user.id } as const,
      fromAccountId: alice.account.id,
      toAccountId: bob.account.id,
      amount: 300n,
      idempotencyKey: "key-1",
    };

    const first = await transferMoney(ledger, command);
    const second = await transferMoney(ledger, command);

    expect(second).toEqual({ transferId: first.transferId, replayed: true });
    expect(await balanceOf(alice.account.id)).toBe(700n);
    expect(await balanceOf(bob.account.id)).toBe(300n);
  });

  it("rejects a key reused with a different payload", async () => {
    const { alice, bob } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 1000n);
    const command = {
      actor: { type: "user", userId: alice.user.id } as const,
      fromAccountId: alice.account.id,
      toAccountId: bob.account.id,
      amount: 300n,
      idempotencyKey: "key-1",
    };
    await transferMoney(ledger, command);

    await expect(transferMoney(ledger, { ...command, amount: 301n })).rejects.toThrow(IdempotencyKeyReuse);
    expect(await balanceOf(alice.account.id)).toBe(700n);
  });

  it("lets two users use the same key without colliding", async () => {
    const { alice, bob } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 1000n);
    await fund(ledger, bob.account.id, 1000n);

    const fromAlice = await transferMoney(ledger, {
      actor: { type: "user", userId: alice.user.id },
      fromAccountId: alice.account.id,
      toAccountId: bob.account.id,
      amount: 100n,
      idempotencyKey: "same-key",
    });
    const fromBob = await transferMoney(ledger, {
      actor: { type: "user", userId: bob.user.id },
      fromAccountId: bob.account.id,
      toAccountId: alice.account.id,
      amount: 40n,
      idempotencyKey: "same-key",
    });

    expect(fromBob.replayed).toBe(false);
    expect(fromBob.transferId).not.toBe(fromAlice.transferId);
    expect(await balanceOf(alice.account.id)).toBe(940n);
  });

  it("does not let a user move money out of someone else's account", async () => {
    const { alice, bob } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 1000n);

    const attempt = transferMoney(ledger, {
      actor: { type: "user", userId: bob.user.id },
      fromAccountId: alice.account.id,
      toAccountId: bob.account.id,
      amount: 100n,
      idempotencyKey: "key-1",
    });

    await expect(attempt).rejects.toThrow(AccountNotFound);
    expect(await balanceOf(alice.account.id)).toBe(1000n);
  });

  it("does not let a user issue money from the system account", async () => {
    const { alice } = await twoUsersInOneSandbox();
    const system = await systemAccount();

    const attempt = transferMoney(ledger, {
      actor: { type: "user", userId: alice.user.id },
      fromAccountId: system.id,
      toAccountId: alice.account.id,
      amount: 100n,
      idempotencyKey: "key-1",
    });

    await expect(attempt).rejects.toThrow(AccountNotFound);
    expect(await globalSum()).toBe(0n);
    expect(await balanceOf(alice.account.id)).toBe(0n);
  });

  it("rejects an unknown account", async () => {
    const { alice } = await twoUsersInOneSandbox();
    await fund(ledger, alice.account.id, 1000n);

    const attempt = transferMoney(ledger, {
      actor: { type: "user", userId: alice.user.id },
      fromAccountId: alice.account.id,
      toAccountId: "00000000-0000-0000-0000-000000000000",
      amount: 100n,
      idempotencyKey: "key-1",
    });

    await expect(attempt).rejects.toThrow(AccountNotFound);
  });

  it("rejects a transfer to an account in another sandbox", async () => {
    const { alice } = await twoUsersInOneSandbox();
    const stranger = await createUserWithAccount((await createSandbox()).id);
    await fund(ledger, alice.account.id, 1000n);

    const attempt = transferMoney(ledger, {
      actor: { type: "user", userId: alice.user.id },
      fromAccountId: alice.account.id,
      toAccountId: stranger.account.id,
      amount: 100n,
      idempotencyKey: "key-1",
    });

    await expect(attempt).rejects.toThrow(CrossSandboxTransfer);
    expect(await balanceOf(stranger.account.id)).toBe(0n);
  });

  describe("outbox", () => {
    it("writes exactly one event for a posted transfer, in the same transaction", async () => {
      const { alice, bob } = await twoUsersInOneSandbox();
      await fund(ledger, alice.account.id, 1000n);

      const result = await transferMoney(ledger, {
        actor: { type: "user", userId: alice.user.id },
        fromAccountId: alice.account.id,
        toAccountId: bob.account.id,
        amount: 300n,
        idempotencyKey: "key-1",
      });

      const events = await prisma.outboxEvent.findMany({ where: { transferId: result.transferId } });
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event).toMatchObject({
        type: "transfer.posted",
        sandboxId: alice.account.sandboxId,
        status: "PENDING",
        attempts: 0,
      });
      expect(JSON.parse(event.payload)).toEqual({
        id: event.id,
        type: "transfer.posted",
        createdAt: expect.any(String),
        data: {
          transferId: result.transferId,
          sandboxId: alice.account.sandboxId,
          entries: [
            { accountId: alice.account.id, amount: "-300", currency: "BRL" },
            { accountId: bob.account.id, amount: "300", currency: "BRL" },
          ],
        },
      });
    });

    it("writes an event for funding from the system account too", async () => {
      const { alice } = await twoUsersInOneSandbox();

      const funding = await fund(ledger, alice.account.id, 1000n);

      expect(await prisma.outboxEvent.count({ where: { transferId: funding.transferId } })).toBe(1);
    });

    it("writes no event when the transfer is rejected", async () => {
      const { alice, bob } = await twoUsersInOneSandbox();
      await fund(ledger, alice.account.id, 100n);
      const eventsBefore = await prisma.outboxEvent.count();

      const attempt = transferMoney(ledger, {
        actor: { type: "user", userId: alice.user.id },
        fromAccountId: alice.account.id,
        toAccountId: bob.account.id,
        amount: 101n,
        idempotencyKey: "key-1",
      });

      await expect(attempt).rejects.toThrow(InsufficientFunds);
      expect(await prisma.outboxEvent.count()).toBe(eventsBefore);
    });

    it("writes no event when the transaction rolls back after the event was recorded", async () => {
      const { alice, bob } = await twoUsersInOneSandbox();
      await fund(ledger, alice.account.id, 1000n);
      const before = {
        events: await prisma.outboxEvent.count(),
        transfers: await prisma.transfer.count(),
        entries: await prisma.ledgerEntry.count(),
      };

      const attempt = transferMoney(ledgerThatFailsBeforeCommit, {
        actor: { type: "user", userId: alice.user.id },
        fromAccountId: alice.account.id,
        toAccountId: bob.account.id,
        amount: 300n,
        idempotencyKey: "key-1",
      });

      await expect(attempt).rejects.toThrow("connection lost before commit");
      expect({
        events: await prisma.outboxEvent.count(),
        transfers: await prisma.transfer.count(),
        entries: await prisma.ledgerEntry.count(),
      }).toEqual(before);
      expect(await balanceOf(alice.account.id)).toBe(1000n);
    });

    it("writes no second event when a request is replayed", async () => {
      const { alice, bob } = await twoUsersInOneSandbox();
      await fund(ledger, alice.account.id, 1000n);
      const command = {
        actor: { type: "user", userId: alice.user.id } as const,
        fromAccountId: alice.account.id,
        toAccountId: bob.account.id,
        amount: 300n,
        idempotencyKey: "key-1",
      };

      const first = await transferMoney(ledger, command);
      await transferMoney(ledger, command);
      await transferMoney(ledger, command);

      expect(await prisma.outboxEvent.count({ where: { transferId: first.transferId } })).toBe(1);
    });
  });
});
