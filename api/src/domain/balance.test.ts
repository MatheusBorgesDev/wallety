import { describe, it, expect } from "vitest";
import { ensureSufficientFunds } from "./balance.js";
import { InsufficientFunds } from "./errors.js";

describe("ensureSufficientFunds", () => {
  it("accepts a user account that ends at exactly zero", () => {
    expect(() => ensureSufficientFunds({ id: "acc-a", kind: "USER" }, 1000n, 1000n)).not.toThrow();
  });

  it("rejects a user account that would go negative", () => {
    expect(() => ensureSufficientFunds({ id: "acc-a", kind: "USER" }, 999n, 1000n)).toThrow(
      InsufficientFunds,
    );
  });

  it("lets the system account go negative: that balance is the money issued", () => {
    expect(() => ensureSufficientFunds({ id: "acc-sys", kind: "SYSTEM" }, 0n, 1000n)).not.toThrow();
  });
});
