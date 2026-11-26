import { describe, it, expect } from "vitest";
import { AccountLimitReached, UnsupportedCurrency } from "./errors.js";
import { ensureCanOpenAccount, MAX_ACCOUNTS_PER_USER } from "./opening.js";

const issuedCurrencies = ["BRL", "USD"];

describe("ensureCanOpenAccount", () => {
  it("allows an account in an issued currency while the user is under the limit", () => {
    expect(() =>
      ensureCanOpenAccount({ existingAccounts: MAX_ACCOUNTS_PER_USER - 1, currency: "USD", issuedCurrencies }),
    ).not.toThrow();
  });

  it("refuses one more account once the limit is reached", () => {
    expect(() =>
      ensureCanOpenAccount({ existingAccounts: MAX_ACCOUNTS_PER_USER, currency: "BRL", issuedCurrencies }),
    ).toThrow(AccountLimitReached);
  });

  it("refuses a currency the ledger cannot issue", () => {
    expect(() => ensureCanOpenAccount({ existingAccounts: 0, currency: "EUR", issuedCurrencies })).toThrow(
      UnsupportedCurrency,
    );
  });
});
