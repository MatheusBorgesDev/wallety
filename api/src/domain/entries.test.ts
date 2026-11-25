import { describe, it, expect } from "vitest";
import { buildEntries, type AccountRef } from "./entries.js";
import {
  CrossSandboxTransfer,
  CurrencyMismatch,
  NonPositiveAmount,
  SameAccountTransfer,
  SystemAccountAsDestination,
} from "./errors.js";

const alice: AccountRef = { id: "acc-a", kind: "USER", currency: "BRL", sandboxId: "sb-1" };
const bob: AccountRef = { id: "acc-b", kind: "USER", currency: "BRL", sandboxId: "sb-1" };
const system: AccountRef = { id: "acc-sys", kind: "SYSTEM", currency: "BRL", sandboxId: null };

describe("buildEntries", () => {
  it("creates a debit on the source and a credit on the destination", () => {
    expect(buildEntries(alice, bob, 1000n)).toEqual([
      { accountId: "acc-a", amount: -1000n, currency: "BRL" },
      { accountId: "acc-b", amount: 1000n, currency: "BRL" },
    ]);
  });

  it("produces entries that sum to zero", () => {
    const sum = buildEntries(alice, bob, 1000n).reduce((total, entry) => total + entry.amount, 0n);
    expect(sum).toBe(0n);
  });

  it("rejects a non-positive amount", () => {
    expect(() => buildEntries(alice, bob, 0n)).toThrow(NonPositiveAmount);
    expect(() => buildEntries(alice, bob, -1n)).toThrow(NonPositiveAmount);
  });

  it("rejects a transfer to the same account", () => {
    expect(() => buildEntries(alice, alice, 1000n)).toThrow(SameAccountTransfer);
  });

  it("rejects a transfer between different currencies", () => {
    const usd: AccountRef = { ...bob, id: "acc-usd", currency: "USD" };
    expect(() => buildEntries(alice, usd, 1000n)).toThrow(CurrencyMismatch);
  });

  it("rejects a transfer between user accounts of different sandboxes", () => {
    const stranger: AccountRef = { ...bob, id: "acc-x", sandboxId: "sb-2" };
    expect(() => buildEntries(alice, stranger, 1000n)).toThrow(CrossSandboxTransfer);
  });

  it("allows funding from the system account into any sandbox", () => {
    expect(buildEntries(system, alice, 5000n)).toEqual([
      { accountId: "acc-sys", amount: -5000n, currency: "BRL" },
      { accountId: "acc-a", amount: 5000n, currency: "BRL" },
    ]);
  });

  it("rejects a system account as the destination", () => {
    expect(() => buildEntries(alice, system, 1000n)).toThrow(SystemAccountAsDestination);
  });
});
