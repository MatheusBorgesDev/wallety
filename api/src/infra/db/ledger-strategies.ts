import type { Ledger } from "../../application/ledger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createPessimisticLedger } from "./pessimistic-ledger.js";
import { createSerializableLedger } from "./serializable-ledger.js";

// Every way this codebase knows to keep a transfer correct under concurrency. The
// integration suites run once per strategy, and the experiment measures each of them.
export const ledgerStrategies = {
  "pessimistic-both": (prisma: PrismaClient) => createPessimisticLedger(prisma, { lock: "both-accounts" }),
  "pessimistic-debit": (prisma: PrismaClient) => createPessimisticLedger(prisma, { lock: "debited-account" }),
  serializable: (prisma: PrismaClient) => createSerializableLedger(prisma),
} satisfies Record<string, (prisma: PrismaClient) => Ledger>;

export type LedgerStrategyName = keyof typeof ledgerStrategies;

export const ledgerStrategyNames = Object.keys(ledgerStrategies) as LedgerStrategyName[];
