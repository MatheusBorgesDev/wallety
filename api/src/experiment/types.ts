import type { LedgerStrategyName } from "../infra/db/ledger-strategies.js";

export type LatencyMs = { p50: number | null; p95: number | null; p99: number | null; max: number | null };

// One strategy under one workload at one concurrency level, measured once.
export type CellResult = {
  strategy: LedgerStrategyName;
  workload: string;
  clients: number;
  repetition: number;
  measuredMs: number;
  // Transfers that committed inside the measurement window.
  committed: number;
  // Transfers refused by a business rule (insufficient funds). Not an error.
  rejected: number;
  // Transfers that ended in an error, by PostgreSQL error code ("other" when there is none).
  failed: number;
  failuresByCode: Record<string, number>;
  // Times the unit of work was run again, by the PostgreSQL error code that caused it.
  retries: number;
  retriesByCode: Record<string, number>;
  // Committed transfers that needed at least one retry.
  committedAfterRetry: number;
  throughputPerSecond: number;
  // Per committed transfer, from the call to its return, retries and their waits included.
  latencyMs: LatencyMs;
  correctness: CorrectnessReport;
};

export type CorrectnessReport = {
  ok: boolean;
  ledgerSum: string;
  negativeUserAccounts: number;
  transfers: number;
  expectedTransfers: number;
  transfersWithoutTwoEntries: number;
  transfersWithoutEvent: number;
  // Twenty simultaneous transfers of 100 out of an account holding 1000, after the load.
  overdraftProbe: { accepted: number; balance: string };
};

export type ExperimentConfig = {
  strategies: LedgerStrategyName[];
  workloads: string[];
  clients: number[];
  repetitions: number;
  warmupMs: number;
  durationMs: number;
  openingBalance: string;
  maxTransferAmount: number;
};

export type ExperimentResult = {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  source: { repository: string | null; commit: string | null; runId: string | null; runAttempt: string | null };
  environment: {
    postgresVersion: string;
    postgresSettings: Record<string, string>;
    node: string;
    platform: string;
    arch: string;
    cpuModel: string;
    cpus: number;
    totalMemoryBytes: number;
    runnerImage: string | null;
  };
  config: ExperimentConfig;
  cells: CellResult[];
};
