import { AccountLimitReached, UnsupportedCurrency } from "./errors.js";

export const MAX_ACCOUNTS_PER_USER = 5;

// A new account starts empty: money only enters the ledger through a transfer. It can
// only be opened in a currency the ledger can issue, that is, one with a system account.
export function ensureCanOpenAccount(input: {
  existingAccounts: number;
  currency: string;
  issuedCurrencies: readonly string[];
}): void {
  if (!input.issuedCurrencies.includes(input.currency)) {
    throw new UnsupportedCurrency(input.currency);
  }
  if (input.existingAccounts >= MAX_ACCOUNTS_PER_USER) {
    throw new AccountLimitReached(MAX_ACCOUNTS_PER_USER);
  }
}
