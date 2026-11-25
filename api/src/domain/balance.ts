import type { AccountRef } from "./account.js";
import { InsufficientFunds } from "./errors.js";

// The caller reads the balance under a lock and passes it in; this rule stays pure.
// The system account is exempt: its negative balance is the total money issued.
export function ensureSufficientFunds(
  account: Pick<AccountRef, "id" | "kind">,
  balance: bigint,
  amount: bigint,
): void {
  if (account.kind === "USER" && balance < amount) {
    throw new InsufficientFunds(account.id);
  }
}
