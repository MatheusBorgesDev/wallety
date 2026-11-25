import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db/prisma.js";
import { InsufficientFunds } from "../domain/errors.js";
import { createPessimisticLedger } from "../infra/db/pessimistic-ledger.js";
import { resetDb, disconnectDb } from "../test/db.js";
import { balanceOf, createSandbox, createUserWithAccount, fund, globalSum } from "../test/fixtures.js";
import { transferMoney } from "./transfer-money.js";

const ledger = createPessimisticLedger(prisma);

describe("transferMoney under concurrency", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("never overspends: 20 simultaneous transfers of 100 from an account holding 1000", async () => {
    const sandbox = await createSandbox();
    const alice = await createUserWithAccount(sandbox.id);
    const bob = await createUserWithAccount(sandbox.id);
    await fund(ledger, alice.account.id, 1000n);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        transferMoney(ledger, {
          actor: { type: "user", userId: alice.user.id },
          fromAccountId: alice.account.id,
          toAccountId: bob.account.id,
          amount: 100n,
          idempotencyKey: `spend-${index}`,
        }),
      ),
    );

    const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(accepted).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(InsufficientFunds);
    }
    expect(await balanceOf(alice.account.id)).toBe(0n);
    expect(await balanceOf(bob.account.id)).toBe(1000n);
    expect(await globalSum()).toBe(0n);
  });

  it("does not deadlock when transfers cross in opposite directions", async () => {
    const sandbox = await createSandbox();
    const alice = await createUserWithAccount(sandbox.id);
    const bob = await createUserWithAccount(sandbox.id);
    await fund(ledger, alice.account.id, 10_000n);
    await fund(ledger, bob.account.id, 10_000n);

    const crossing = Array.from({ length: 20 }, (_, index) => [
      transferMoney(ledger, {
        actor: { type: "user", userId: alice.user.id },
        fromAccountId: alice.account.id,
        toAccountId: bob.account.id,
        amount: 7n,
        idempotencyKey: `a-to-b-${index}`,
      }),
      transferMoney(ledger, {
        actor: { type: "user", userId: bob.user.id },
        fromAccountId: bob.account.id,
        toAccountId: alice.account.id,
        amount: 3n,
        idempotencyKey: `b-to-a-${index}`,
      }),
    ]).flat();

    const outcomes = await Promise.allSettled(crossing);

    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    expect(await balanceOf(alice.account.id)).toBe(10_000n - 20n * 7n + 20n * 3n);
    expect(await balanceOf(bob.account.id)).toBe(10_000n + 20n * 7n - 20n * 3n);
    expect(await globalSum()).toBe(0n);
  });

  it("creates exactly one transfer for 10 simultaneous requests with the same key", async () => {
    const sandbox = await createSandbox();
    const alice = await createUserWithAccount(sandbox.id);
    const bob = await createUserWithAccount(sandbox.id);
    await fund(ledger, alice.account.id, 1000n);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        transferMoney(ledger, {
          actor: { type: "user", userId: alice.user.id },
          fromAccountId: alice.account.id,
          toAccountId: bob.account.id,
          amount: 100n,
          idempotencyKey: "double-click",
        }),
      ),
    );

    expect(new Set(results.map((result) => result.transferId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await balanceOf(alice.account.id)).toBe(900n);
    expect(await balanceOf(bob.account.id)).toBe(100n);
  });
});
