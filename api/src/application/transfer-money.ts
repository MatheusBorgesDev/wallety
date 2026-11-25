import { createHash, randomUUID } from "node:crypto";
import { ensureSufficientFunds } from "../domain/balance.js";
import { buildEntries } from "../domain/entries.js";
import { AccountNotFound, IdempotencyKeyReuse } from "./errors.js";
import { buildTransferPostedEvent } from "./events.js";
import type { AccountRecord, Ledger } from "./ledger.js";

// A user moves money out of an account they own. The system issues money from
// the SYSTEM account of a currency; no user request can act as the system.
export type Actor = { type: "user"; userId: string } | { type: "system" };

export type TransferCommand = {
  actor: Actor;
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  idempotencyKey: string;
};

export type TransferResult = {
  transferId: string;
  // True when this key had already produced a transfer: nothing was written again.
  replayed: boolean;
};

export async function transferMoney(ledger: Ledger, command: TransferCommand): Promise<TransferResult> {
  const scope = command.actor.type === "user" ? command.actor.userId : "system";
  const requestHash = hashRequest(command);

  return ledger.transaction(async (tx) => {
    const transferId = randomUUID();
    const claim = await tx.claimIdempotencyKey({
      transferId,
      scope,
      key: command.idempotencyKey,
      requestHash,
      createdByUserId: command.actor.type === "user" ? command.actor.userId : null,
    });
    if (!claim.claimed) {
      if (claim.existing.requestHash !== requestHash) {
        throw new IdempotencyKeyReuse();
      }
      return { transferId: claim.existing.transferId, replayed: true };
    }

    const accounts = await tx.loadAccountsForTransfer([command.fromAccountId, command.toAccountId]);
    const from = findAccount(accounts, command.fromAccountId);
    const to = findAccount(accounts, command.toAccountId);
    ensureActorMayDebit(command.actor, from);

    const entries = buildEntries(from, to, command.amount);
    ensureSufficientFunds(from, await tx.balanceOf(from.id), command.amount);
    await tx.appendEntries(transferId, entries);
    // Same transaction as the entries: the event exists if and only if the transfer commits.
    await tx.recordEvent(
      buildTransferPostedEvent({
        eventId: randomUUID(),
        transferId,
        // buildEntries only accepts a user account as the destination, and those always have a sandbox.
        sandboxId: to.sandboxId!,
        entries,
        occurredAt: new Date(),
      }),
    );

    return { transferId, replayed: false };
  });
}

function findAccount(accounts: AccountRecord[], accountId: string): AccountRecord {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    throw new AccountNotFound(accountId);
  }
  return account;
}

function ensureActorMayDebit(actor: Actor, from: AccountRecord): void {
  const allowed =
    actor.type === "system"
      ? from.kind === "SYSTEM"
      : from.kind === "USER" && from.userId === actor.userId;
  if (!allowed) {
    throw new AccountNotFound(from.id);
  }
}

function hashRequest(command: TransferCommand): string {
  const canonical = JSON.stringify([command.fromAccountId, command.toAccountId, command.amount.toString()]);
  return createHash("sha256").update(canonical).digest("hex");
}
