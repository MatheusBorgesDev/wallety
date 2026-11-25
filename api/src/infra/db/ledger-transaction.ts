import type { AccountRecord, LedgerTransaction } from "../../application/ledger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

export type PrismaTransaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

type TransferAccounts = { debitAccountId: string; creditAccountId: string };

// Runs after the accounts were read and before the balance is: the place where a
// strategy takes whatever row locks it relies on.
export type ProtectAccounts = (
  tx: PrismaTransaction,
  accounts: AccountRecord[],
  transfer: TransferAccounts,
) => Promise<void>;

// The statements every concurrency strategy shares. Strategies differ only in the
// isolation level of the surrounding transaction and in what `protect` locks.
export function ledgerTransaction(tx: PrismaTransaction, protect: ProtectAccounts): LedgerTransaction {
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

    async loadAccountsForTransfer(transfer) {
      // Kind, currency, owner and sandbox never change, so they can be read before locking.
      const accounts: AccountRecord[] = await tx.account.findMany({
        where: { id: { in: [transfer.debitAccountId, transfer.creditAccountId] } },
        select: { id: true, kind: true, currency: true, sandboxId: true, userId: true },
      });
      await protect(tx, accounts, transfer);
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

    async recordEvent(event) {
      await tx.outboxEvent.create({ data: event });
    },
  };
}
