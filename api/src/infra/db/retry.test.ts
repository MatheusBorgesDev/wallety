import { describe, it, expect } from "vitest";
import { retryDelayCeilingMs, retryOnConflict, sqlStateOf, type RetryPolicy } from "./retry.js";

// The shape Prisma 7 gives a PostgreSQL error raised through the pg driver adapter.
function prismaError(sqlState: string, prismaCode = "P2010") {
  return Object.assign(new Error("Raw query failed"), {
    code: prismaCode,
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: sqlState } } },
  });
}

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 2, maxDelayMs: 10 };
const noSleep = async () => {};

describe("sqlStateOf", () => {
  it("finds the PostgreSQL error code inside a Prisma error", () => {
    expect(sqlStateOf(prismaError("40001"))).toBe("40001");
    expect(sqlStateOf(prismaError("40P01", "P2034"))).toBe("40P01");
  });

  it("returns undefined for errors that did not come from the database", () => {
    expect(sqlStateOf(new Error("boom"))).toBeUndefined();
    expect(sqlStateOf(undefined)).toBeUndefined();
    expect(sqlStateOf("40001")).toBeUndefined();
  });
});

describe("retryOnConflict", () => {
  it("returns the first result when nothing fails", async () => {
    let calls = 0;
    const result = await retryOnConflict(async () => ++calls, policy, { sleep: noSleep });
    expect(result).toBe(1);
  });

  it("runs again after a serialization failure and after a deadlock", async () => {
    const failures = [prismaError("40001"), prismaError("40P01")];
    const retried: string[] = [];
    const result = await retryOnConflict(
      async () => {
        const failure = failures.shift();
        if (failure) throw failure;
        return "done";
      },
      policy,
      { sleep: noSleep, onRetry: (sqlState) => retried.push(sqlState) },
    );
    expect(result).toBe("done");
    expect(retried).toEqual(["40001", "40P01"]);
  });

  it("does not retry any other error", async () => {
    let calls = 0;
    const attempt = retryOnConflict(
      async () => {
        calls += 1;
        throw prismaError("23505");
      },
      policy,
      { sleep: noSleep },
    );
    await expect(attempt).rejects.toThrow("Raw query failed");
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts and throws the last conflict", async () => {
    let calls = 0;
    const retried: string[] = [];
    const attempt = retryOnConflict(
      async () => {
        calls += 1;
        throw prismaError("40001");
      },
      policy,
      { sleep: noSleep, onRetry: (sqlState) => retried.push(sqlState) },
    );
    await expect(attempt).rejects.toMatchObject({ code: "P2010" });
    expect(calls).toBe(4);
    expect(retried).toHaveLength(3);
  });

  it("waits a random time under a ceiling that doubles and then stops growing", async () => {
    expect([1, 2, 3, 4, 5].map((retry) => retryDelayCeilingMs(policy, retry))).toEqual([2, 4, 8, 10, 10]);

    const waits: number[] = [];
    await retryOnConflict(
      async () => {
        if (waits.length < 3) throw prismaError("40001");
      },
      policy,
      { sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
    );
    expect(waits).toEqual([1, 2, 4]);
  });
});
