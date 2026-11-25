import type { Ledger } from "../../application/ledger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { ledgerTransaction, type ProtectAccounts } from "./ledger-transaction.js";

// Which accounts a transfer locks before reading the balance of the debited one.
//
// "both-accounts": SELECT ... FOR UPDATE on every user account of the transfer, in
// ascending id order. Transfers that cross (A to B, B to A) queue up instead of
// deadlocking, because both ask for the same lock first.
//
// "debited-account": only the account that loses money. Balances are derived, so a credit
// never reads a balance and needs no lock of its own. The lock is FOR NO KEY UPDATE: the
// ledger entry inserted for the credited account takes a KEY SHARE lock on that account's
// row through its foreign key, and FOR UPDATE would block it, which lets crossing
// transfers deadlock.
export type LockScope = "both-accounts" | "debited-account";

// Pessimistic locking under READ COMMITTED: two transfers that debit the same account run
// one after the other, and the second one sees the first one's entries.
export function createPessimisticLedger(
  prisma: PrismaClient,
  options: { lock: LockScope } = { lock: "both-accounts" },
): Ledger {
  const protect = options.lock === "both-accounts" ? lockBothAccounts : lockDebitedAccount;
  return {
    transaction: (work) =>
      prisma.$transaction((tx) => work(ledgerTransaction(tx, protect)), {
        isolationLevel: "ReadCommitted",
        maxWait: 10_000,
        timeout: 15_000,
      }),
  };
}

// The system account is never locked: it has no balance rule to protect, and locking it
// would make every funding transfer in the system wait in a single line.
const lockBothAccounts: ProtectAccounts = async (tx, accounts) => {
  const idsToLock = accounts
    .filter((account) => account.kind === "USER")
    .map((account) => account.id)
    .sort();
  for (const id of idsToLock) {
    await tx.$queryRaw`SELECT 1 FROM "accounts" WHERE "id" = ${id} FOR UPDATE`;
  }
};

const lockDebitedAccount: ProtectAccounts = async (tx, accounts, { debitAccountId }) => {
  const debited = accounts.find((account) => account.id === debitAccountId);
  if (debited?.kind === "USER") {
    await tx.$queryRaw`SELECT 1 FROM "accounts" WHERE "id" = ${debited.id} FOR NO KEY UPDATE`;
  }
};
