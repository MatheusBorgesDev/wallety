import type { AccountRecord, Ledger, LedgerTransaction } from "../../application/ledger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

type PrismaTransaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// Pessimistic locking under READ COMMITTED. Every user account a transfer touches is
// locked with SELECT ... FOR UPDATE before its balance is read, so two transfers on the
// same account run one after the other and the second one sees the first one's entries.
// Locks are taken in ascending id order: transfers that cross (A to B, B to A) queue up
// instead of deadlocking.
export function createPessimisticLedger(prisma: PrismaClient): Ledger {
  return {
    transaction: (work) =>
      prisma.$transaction((tx) => work(ledgerTransaction(tx)), {
        isolationLevel: "ReadCommitted",
        maxWait: 10_000,
        timeout: 15_000,
      }),
  };
}

function ledgerTransaction(tx: PrismaTransaction): LedgerTransaction {
  return {
    async claimIdempotencyKey({ transferId, scope, key, requestHash, createdByUserId }) {
      // ON CONFLICT DO NOTHING waits for a concurrent request holding the same key to
      // finish, then inserts nothing. Exactly one request claims the key.
      const inserted = await tx.$executeRaw`
        INSERT INTO "transfers" ("id", "idempotencyScope", "idempotencyKey", "requestHash", "createdByUserId")
        VALUES (${transferId}, ${scope}, ${key}, ${requestHash}, ${createdByUserId})
        ON CONFLICT ("idempotencyScope", "idempotencyKey") DO NOTHING`;
      if (inserted === 1) {
        return { claimed: true };
      }
      const existing = await tx.transfer.findUniqueOrThrow({
        where: { idempotencyScope_idempotencyKey: { idempotencyScope: scope, idempotencyKey: key } },
        select: { id: true, requestHash: true },
      });
      return { claimed: false, existing: { transferId: existing.id, requestHash: existing.requestHash } };
    },

    async loadAccountsForTransfer(accountIds) {
      // Kind, currency, owner and sandbox never change, so they can be read before locking.
      const accounts: AccountRecord[] = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, kind: true, currency: true, sandboxId: true, userId: true },
      });
      // The system account is left unlocked: it has no balance rule to protect, and locking
      // it would make every funding transfer in the system wait in a single line.
      const idsToLock = accounts
        .filter((account) => account.kind === "USER")
        .map((account) => account.id)
        .sort();
      for (const id of idsToLock) {
        await tx.$queryRaw`SELECT 1 FROM "accounts" WHERE "id" = ${id} FOR UPDATE`;
      }
      return accounts;
    },

    async balanceOf(accountId) {
      const [row] = await tx.$queryRaw<{ balance: string }[]>`
        SELECT COALESCE(sum("amount"), 0)::text AS balance FROM "ledger_entries" WHERE "accountId" = ${accountId}`;
      return BigInt(row!.balance);
    },

    async appendEntries(transferId, entries) {
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transferId })) });
    },
  };
}
