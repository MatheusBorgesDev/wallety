import { describe, it, expect } from "vitest";
import { pickPair, workloads } from "./workloads.js";

// A deterministic generator, so the distribution checks below never flake.
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

describe("pickPair", () => {
  it.each(Object.values(workloads))("$name: always two different accounts inside the range", (workload) => {
    const random = seededRandom(1);
    for (let round = 0; round < 5000; round += 1) {
      const [from, to] = pickPair(workload, random);
      expect(from).not.toBe(to);
      for (const index of [from, to]) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(workload.accounts);
      }
    }
  });

  it("high contention: every transfer stays among a handful of accounts", () => {
    expect(workloads["high-contention"].accounts).toBeLessThanOrEqual(8);
  });

  it("mixed: about half of the transfers stay inside the hot accounts", () => {
    const workload = workloads.mixed;
    const random = seededRandom(7);
    const rounds = 20_000;
    let insideHotSet = 0;
    for (let round = 0; round < rounds; round += 1) {
      const [from, to] = pickPair(workload, random);
      if (from < workload.hotAccounts && to < workload.hotAccounts) insideHotSet += 1;
    }
    expect(insideHotSet / rounds).toBeGreaterThan(0.48);
    expect(insideHotSet / rounds).toBeLessThan(0.52);
  });

  it("low contention: transfers almost never stay inside any four accounts", () => {
    const workload = workloads["low-contention"];
    const random = seededRandom(3);
    let insideFirstFour = 0;
    for (let round = 0; round < 20_000; round += 1) {
      const [from, to] = pickPair(workload, random);
      if (from < 4 && to < 4) insideFirstFour += 1;
    }
    expect(insideFirstFour).toBeLessThan(20);
  });
});
