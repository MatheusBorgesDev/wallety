import type { Ledger } from "../../application/ledger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createPessimisticLedger } from "./pessimistic-ledger.js";
import { createSerializableLedger } from "./serializable-ledger.js";

export const ledgerStrategyNames = ["pessimistic-both", "pessimistic-debit", "serializable"] as const;

export type LedgerStrategyName = (typeof ledgerStrategyNames)[number];

// `onRetry` is called each time a strategy runs a unit of work again, with the PostgreSQL
// error code that caused it. Strategies that never retry never call it.
type LedgerFactory = (prisma: PrismaClient, hooks?: { onRetry?: (sqlState: string) => void }) => Ledger;

// Every way this codebase knows to keep a transfer correct under concurrency. The
// integration suites run once per strategy, and the experiment measures each of them.
export const ledgerStrategies: Record<LedgerStrategyName, LedgerFactory> = {
  "pessimistic-both": (prisma) => createPessimisticLedger(prisma, { lock: "both-accounts" }),
  "pessimistic-debit": (prisma) => createPessimisticLedger(prisma, { lock: "debited-account" }),
  serializable: (prisma, hooks) => createSerializableLedger(prisma, hooks),
};
