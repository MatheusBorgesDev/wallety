import type { IdentityTransaction, NewUser, SandboxKind } from "./identity.js";
import type { LedgerTransaction } from "./ledger.js";
import { postTransfer } from "./transfer-money.js";

export const OPENING_CURRENCY = "BRL";
// 1,000.00 in minor units.
export const OPENING_BALANCE = 100_000n;

export type ProvisionedSandbox = {
  sandboxId: string;
  owner: { userId: string; accountId: string };
  counterpart: { userId: string; accountId: string };
};

// Everything a new user needs to try the product, created in the caller's unit of work:
// a sandbox, the user with a funded account, and a second user to transfer to. Users only
// transact inside their own sandbox, so without the counterpart there would be no one to pay.
//
// The opening balance is a regular transfer out of the system account: the ledger never
// creates money.
export async function provisionSandbox(
  tx: { identity: IdentityTransaction; ledger: LedgerTransaction },
  input: { kind: SandboxKind; expiresAt: Date | null; owner: Omit<NewUser, "sandboxId"> },
): Promise<ProvisionedSandbox> {
  const { identity, ledger } = tx;
  const sandbox = await identity.createSandbox({ kind: input.kind, expiresAt: input.expiresAt });

  const owner = await identity.createUser({ ...input.owner, sandboxId: sandbox.id });
  const ownerAccount = await identity.createAccount({
    userId: owner.id,
    sandboxId: sandbox.id,
    name: "Main",
    currency: OPENING_CURRENCY,
  });

  const counterpart = await identity.createUser({
    sandboxId: sandbox.id,
    email: null,
    passwordHash: null,
    displayName: "Sample recipient",
  });
  const counterpartAccount = await identity.createAccount({
    userId: counterpart.id,
    sandboxId: sandbox.id,
    name: "Main",
    currency: OPENING_CURRENCY,
  });

  await postTransfer(ledger, {
    actor: { type: "system" },
    fromAccountId: await identity.systemAccountId(OPENING_CURRENCY),
    toAccountId: ownerAccount.id,
    amount: OPENING_BALANCE,
    idempotencyKey: `seed:${ownerAccount.id}`,
  });

  return {
    sandboxId: sandbox.id,
    owner: { userId: owner.id, accountId: ownerAccount.id },
    counterpart: { userId: counterpart.id, accountId: counterpartAccount.id },
  };
}
