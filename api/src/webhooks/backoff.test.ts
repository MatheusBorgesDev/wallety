import { describe, it, expect } from "vitest";
import { defaultRetryPolicy, retryDelayMs } from "./backoff.js";

describe("retry backoff", () => {
  it("doubles the wait after each failed attempt", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, defaultRetryPolicy));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("gives up after a fixed number of attempts", () => {
    expect(defaultRetryPolicy.maxAttempts).toBe(6);
  });
});
