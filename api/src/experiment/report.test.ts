import { describe, it, expect } from "vitest";
import { compareRuns, renderReport, summarize } from "./report.js";
import type { CellResult, ExperimentResult } from "./types.js";

function cell(overrides: Partial<CellResult>): CellResult {
  return {
    strategy: "serializable",
    workload: "high-contention",
    clients: 4,
    repetition: 1,
    measuredMs: 10_000,
    committed: 1000,
    rejected: 0,
    failed: 0,
    failuresByCode: {},
    retries: 0,
    retriesByCode: {},
    committedAfterRetry: 0,
    throughputPerSecond: 100,
    latencyMs: { p50: 10, p95: 20, p99: 30, max: 40 },
    correctness: {
      ok: true,
      ledgerSum: "0",
      negativeUserAccounts: 0,
      transfers: 1004,
      expectedTransfers: 1004,
      transfersWithoutTwoEntries: 0,
      transfersWithoutEvent: 0,
      overdraftProbe: { accepted: 10, balance: "0" },
    },
    ...overrides,
  };
}

function result(cells: CellResult[], runId = "1"): ExperimentResult {
  return {
    schemaVersion: 1,
    startedAt: "2026-11-25T20:00:00.000Z",
    finishedAt: "2026-11-25T20:30:00.000Z",
    source: { repository: "owner/repo", commit: "abc1234def", runId, runAttempt: "1" },
    environment: {
      postgresVersion: "16.4",
      postgresSettings: { fsync: "on" },
      node: "v24.0.0",
      platform: "linux 6.8",
      arch: "x64",
      cpuModel: "Test CPU",
      cpus: 4,
      totalMemoryBytes: 16 * 1024 ** 3,
      runnerImage: "ubuntu24 1.0",
    },
    config: {
      strategies: ["pessimistic-both", "serializable"],
      workloads: ["high-contention"],
      clients: [4],
      repetitions: 3,
      warmupMs: 3000,
      durationMs: 10_000,
      openingBalance: "1000",
      maxTransferAmount: 100,
    },
    cells,
  };
}

describe("summarize", () => {
  it("takes the median over repetitions and keeps the lowest and highest throughput", () => {
    const [row] = summarize(
      result([
        cell({ repetition: 1, throughputPerSecond: 90, latencyMs: { p50: 9, p95: 19, p99: 50, max: 60 } }),
        cell({ repetition: 2, throughputPerSecond: 120, latencyMs: { p50: 12, p95: 22, p99: 32, max: 60 } }),
        cell({ repetition: 3, throughputPerSecond: 100, latencyMs: { p50: 10, p95: 20, p99: 30, max: 60 } }),
      ]),
    );
    expect(row).toMatchObject({
      strategy: "serializable",
      workload: "high-contention",
      clients: 4,
      repetitions: 3,
      throughput: { median: 100, min: 90, max: 120 },
      latencyMs: { p50: 10, p95: 20, p99: 32 },
    });
  });

  it("reports retries per 100 committed transfers, and adds up failures and rejections", () => {
    const [row] = summarize(
      result([
        cell({ repetition: 1, committed: 1000, retries: 250, failed: 2, rejected: 1 }),
        cell({ repetition: 2, committed: 2000, retries: 300, failed: 0, rejected: 0 }),
        cell({ repetition: 3, committed: 1000, retries: 400, failed: 1, rejected: 0 }),
      ]),
    );
    expect(row).toMatchObject({ retriesPer100Committed: 25, failed: 3, rejected: 1, correct: true });
  });

  it("marks a group as incorrect when any repetition failed the ledger checks", () => {
    const broken = cell({ repetition: 2 });
    broken.correctness = { ...broken.correctness, ok: false, ledgerSum: "-5" };
    const [row] = summarize(result([cell({ repetition: 1 }), broken]));
    expect(row!.correct).toBe(false);
  });

  it("keeps one row per strategy, workload and concurrency level", () => {
    const rows = summarize(
      result([
        cell({ strategy: "serializable", clients: 4 }),
        cell({ strategy: "pessimistic-both", clients: 4 }),
        cell({ strategy: "serializable", clients: 16 }),
      ]),
    );
    expect(rows.map((row) => `${row.strategy}/${row.clients}`)).toEqual([
      "pessimistic-both/4",
      "serializable/4",
      "serializable/16",
    ]);
  });
});

describe("renderReport", () => {
  it("states where the numbers came from and prints one table row per group", () => {
    const report = renderReport(result([cell({}), cell({ strategy: "pessimistic-both", throughputPerSecond: 250 })], "777"));
    expect(report).toContain("run 777");
    expect(report).toContain("abc1234");
    expect(report).toContain("PostgreSQL 16.4");
    expect(report).toContain("4 CPUs");
    expect(report).toContain("| high-contention | 4 | pessimistic-both | 250 (250–250) |");
    expect(report).toContain("| high-contention | 4 | serializable | 100 (100–100) | 10 | 20 | 30 | 0 | 0 |");
  });

  it("flags a group that left the ledger incorrect instead of printing its numbers as valid", () => {
    const broken = cell({});
    broken.correctness = { ...broken.correctness, ok: false };
    expect(renderReport(result([broken]))).toContain("INCORRECT");
  });
});

describe("compareRuns", () => {
  it("gives, per group, how far the median throughput of each run is from the first run", () => {
    const first = result([cell({ throughputPerSecond: 100 })], "1");
    const second = result([cell({ throughputPerSecond: 110 })], "2");
    const [row] = compareRuns([first, second]);
    expect(row).toMatchObject({ strategy: "serializable", throughputByRun: [100, 110], maxDeviationPercent: 10 });
  });
});
