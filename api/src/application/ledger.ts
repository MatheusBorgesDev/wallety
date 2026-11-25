import type { AccountRef } from "../domain/account.js";
import type { EntryDraft } from "../domain/entries.js";
import type { OutboxEventDraft } from "./events.js";

export type AccountRecord = AccountRef & { userId: string | null };

export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; existing: { transferId: string; requestHash: string } };

// What a use case may do inside one atomic unit of work. How the unit of work
// stays correct under concurrency (locks, isolation level, retries) is the
// business of the implementation, not of the use case.
export type LedgerTransaction = {
  claimIdempotencyKey(input: {
    transferId: string;
    scope: string;
    key: string;
    requestHash: string;
    createdByUserId: string | null;
  }): Promise<IdempotencyClaim>;
  // Loads the accounts a transfer touches, protected against concurrent transfers.
  loadAccountsForTransfer(accountIds: string[]): Promise<AccountRecord[]>;
  balanceOf(accountId: string): Promise<bigint>;
  appendEntries(transferId: string, entries: EntryDraft[]): Promise<void>;
  // Records an outgoing event in the same unit of work. Delivering it is someone else's job:
  // nothing here can reach the network.
  recordEvent(event: OutboxEventDraft): Promise<void>;
};

export type Ledger = {
  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
};
