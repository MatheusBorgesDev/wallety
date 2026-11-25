import type { AccountRef } from "./account.js";
import {
  CrossSandboxTransfer,
  CurrencyMismatch,
  NonPositiveAmount,
  SameAccountTransfer,
  SystemAccountAsDestination,
} from "./errors.js";

export type { AccountRef };

// A ledger entry before it is persisted. The amount is signed and in minor
// units (cents): negative is a debit, positive is a credit.
export type EntryDraft = {
  accountId: string;
  amount: bigint;
  currency: string;
};

// Validates a transfer and builds its two entries. Because validation and
// construction happen together, an invalid transfer can never yield entries,
// and the entries always sum to zero by construction.
export function buildEntries(from: AccountRef, to: AccountRef, amount: bigint): EntryDraft[] {
  if (amount <= 0n) {
    throw new NonPositiveAmount(amount);
  }
  if (from.id === to.id) {
    throw new SameAccountTransfer(from.id);
  }
  if (to.kind === "SYSTEM") {
    throw new SystemAccountAsDestination(to.id);
  }
  if (from.currency !== to.currency) {
    throw new CurrencyMismatch(from.currency, to.currency);
  }
  // Funding from the system account is the only transfer that crosses a sandbox boundary.
  if (from.kind === "USER" && from.sandboxId !== to.sandboxId) {
    throw new CrossSandboxTransfer();
  }

  return [
    { accountId: from.id, amount: -amount, currency: from.currency },
    { accountId: to.id, amount, currency: to.currency },
  ];
}
