import type { Ledger } from "../../application/ledger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { ledgerTransaction, type ProtectAccounts } from "./ledger-transaction.js";
import { retryOnConflict, type RetryPolicy } from "./retry.js";

export const defaultSerializableRetryPolicy: RetryPolicy = { maxAttempts: 30, baseDelayMs: 2, maxDelayMs: 50 };

export type SerializableLedgerOptions = {
  retry?: RetryPolicy;
  onRetry?: (sqlState: string) => void;
};

// SERIALIZABLE with no explicit lock. PostgreSQL tracks what each transaction read and
// aborts one of two transfers whose outcome depends on the order they ran in, for example
// two debits that both read the same balance. The aborted unit of work runs again from
// the start, on a fresh snapshot, so the use case must be safe to repeat: it is, because
// nothing it does leaves the transaction.
export function createSerializableLedger(prisma: PrismaClient, options: SerializableLedgerOptions = {}): Ledger {
  const policy = options.retry ?? defaultSerializableRetryPolicy;
  return {
    transaction: (work) =>
      retryOnConflict(
        () =>
          prisma.$transaction((tx) => work(ledgerTransaction(tx, takeNoLocks)), {
            isolationLevel: "Serializable",
            maxWait: 10_000,
            timeout: 15_000,
          }),
        policy,
        { onRetry: options.onRetry },
      ),
  };
}

const takeNoLocks: ProtectAccounts = async () => {};
