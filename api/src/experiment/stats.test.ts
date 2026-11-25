import { describe, it, expect } from "vitest";
import { median, percentile, spread } from "./stats.js";

describe("percentile (nearest rank)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, index) => index + 1);

  it("returns the value at or above the requested share of the samples", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("does not depend on the order of the samples and does not reorder them", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 99)).toBe(9);
    expect(samples).toEqual([9, 1, 5, 3, 7]);
  });

  it("returns null when there is nothing to measure", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("median and spread", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("reports the lowest and highest value", () => {
    expect(spread([3, 1, 2])).toEqual({ min: 1, max: 3 });
    expect(spread([])).toBeNull();
  });
});
