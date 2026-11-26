import { describe, it, expect } from "vitest";
import { windowAt } from "./rate-limiter.js";

describe("windowAt", () => {
  it("puts every moment of a window in the same window", () => {
    const first = windowAt(new Date("2026-01-01T00:05:00.000Z"), 300);
    const last = windowAt(new Date("2026-01-01T00:09:59.999Z"), 300);
    const next = windowAt(new Date("2026-01-01T00:10:00.000Z"), 300);
    expect(first.start).toEqual(new Date("2026-01-01T00:05:00.000Z"));
    expect(last.start).toEqual(first.start);
    expect(next.start).toEqual(new Date("2026-01-01T00:10:00.000Z"));
  });

  it("says how many whole seconds are left, never less than one", () => {
    expect(windowAt(new Date("2026-01-01T00:05:00.000Z"), 300).secondsLeft).toBe(300);
    expect(windowAt(new Date("2026-01-01T00:09:30.500Z"), 300).secondsLeft).toBe(30);
    expect(windowAt(new Date("2026-01-01T00:09:59.999Z"), 300).secondsLeft).toBe(1);
  });
});
