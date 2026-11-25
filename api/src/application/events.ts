import type { EntryDraft } from "../domain/entries.js";

// An event waiting in the outbox. The payload is serialized once, here, so every
// delivery attempt sends and signs exactly the same bytes.
export type OutboxEventDraft = {
  id: string;
  type: "transfer.posted";
  transferId: string;
  sandboxId: string;
  payload: string;
};

export function buildTransferPostedEvent(input: {
  eventId: string;
  transferId: string;
  sandboxId: string;
  entries: EntryDraft[];
  occurredAt: Date;
}): OutboxEventDraft {
  const payload = JSON.stringify({
    id: input.eventId,
    type: "transfer.posted",
    createdAt: input.occurredAt.toISOString(),
    data: {
      transferId: input.transferId,
      sandboxId: input.sandboxId,
      // Amounts are strings: JSON numbers lose precision beyond 2^53.
      entries: input.entries.map((entry) => ({
        accountId: entry.accountId,
        amount: entry.amount.toString(),
        currency: entry.currency,
      })),
    },
  });
  return {
    id: input.eventId,
    type: "transfer.posted",
    transferId: input.transferId,
    sandboxId: input.sandboxId,
    payload,
  };
}
