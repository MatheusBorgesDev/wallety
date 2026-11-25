import { median, spread } from "./stats.js";
import type { CellResult, ExperimentResult } from "./types.js";

export type SummaryRow = {
  workload: string;
  clients: number;
  strategy: string;
  repetitions: number;
  // Committed transfers per second: median over the repetitions, with the lowest and highest one.
  throughput: { median: number; min: number; max: number };
  // Median over the repetitions of each percentile.
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  // Median over the repetitions.
  retriesPer100Committed: number;
  failed: number;
  rejected: number;
  correct: boolean;
};

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const present = (values: (number | null)[]) => values.filter((value): value is number => value !== null);

export function summarize(result: ExperimentResult): SummaryRow[] {
  const groups = new Map<string, CellResult[]>();
  for (const cell of result.cells) {
    const key = [cell.workload, cell.clients, cell.strategy].join("|");
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const rows = [...groups.values()].map((cells): SummaryRow => {
    const first = cells[0]!;
    const throughputs = cells.map((cell) => cell.throughputPerSecond);
    const medianOf = (pick: (cell: CellResult) => number | null) => {
      const value = median(present(cells.map(pick)));
      return value === null ? null : round(value);
    };
    return {
      workload: first.workload,
      clients: first.clients,
      strategy: first.strategy,
      repetitions: cells.length,
      throughput: { median: round(median(throughputs)!), ...spread(throughputs.map((value) => round(value)))! },
      latencyMs: {
        p50: medianOf((cell) => cell.latencyMs.p50),
        p95: medianOf((cell) => cell.latencyMs.p95),
        p99: medianOf((cell) => cell.latencyMs.p99),
      },
      retriesPer100Committed: round(
        median(cells.map((cell) => (cell.committed === 0 ? 0 : (cell.retries / cell.committed) * 100)))!,
      ),
      failed: cells.reduce((total, cell) => total + cell.failed, 0),
      rejected: cells.reduce((total, cell) => total + cell.rejected, 0),
      correct: cells.every((cell) => cell.correctness.ok),
    };
  });
  const position = (list: (string | number)[], value: string | number) => list.indexOf(value);
  return rows.sort(
    (a, b) =>
      position(result.config.workloads, a.workload) - position(result.config.workloads, b.workload) ||
      a.clients - b.clients ||
      a.strategy.localeCompare(b.strategy),
  );
}

function describeSource(result: ExperimentResult): string {
  const { source, environment, config } = result;
  const where = source.runId ? `GitHub Actions run ${source.runId}` : "a local run";
  const memoryGb = round(environment.totalMemoryBytes / 1024 ** 3);
  return [
    `Measured on ${result.startedAt.slice(0, 10)} in ${where}, commit ${source.commit?.slice(0, 7) ?? "unknown"}.`,
    `PostgreSQL ${environment.postgresVersion}, Node ${environment.node}, ${environment.cpus} CPUs (${environment.cpuModel}), ${memoryGb} GB of memory${environment.runnerImage ? `, runner image ${environment.runnerImage}` : ""}.`,
    `${config.repetitions} repetition(s) of ${config.durationMs / 1000} s each, after ${config.warmupMs / 1000} s of warm-up.`,
  ].join(" ");
}

const cellText = (value: number | null) => (value === null ? "–" : String(value));

export function renderTable(rows: SummaryRow[]): string {
  const header = [
    "| Workload | Clients | Strategy | Transfers/s, median (min–max) | p50 ms | p95 ms | p99 ms | Retries per 100 transfers | Failed |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  const lines = rows.map((row) => {
    const throughput = `${row.throughput.median} (${row.throughput.min}–${row.throughput.max})`;
    const columns = [
      row.workload,
      row.clients,
      row.correct ? row.strategy : `${row.strategy} (INCORRECT)`,
      throughput,
      cellText(row.latencyMs.p50),
      cellText(row.latencyMs.p95),
      cellText(row.latencyMs.p99),
      row.retriesPer100Committed,
      row.failed,
    ];
    return `| ${columns.join(" | ")} |`;
  });
  return [...header, ...lines].join("\n");
}

export function renderReport(result: ExperimentResult): string {
  return `${describeSource(result)}\n\n${renderTable(summarize(result))}\n`;
}

export type ComparisonRow = {
  workload: string;
  clients: number;
  strategy: string;
  // Median throughput of the group in each run, in the order the runs were given.
  throughputByRun: number[];
  // Largest distance from the first run, as a percentage of the first run.
  maxDeviationPercent: number;
};

export function compareRuns(results: ExperimentResult[]): ComparisonRow[] {
  const [first, ...others] = results.map(summarize);
  return (first ?? []).map((row) => {
    const sameGroup = (candidate: SummaryRow) =>
      candidate.workload === row.workload && candidate.clients === row.clients && candidate.strategy === row.strategy;
    const throughputByRun = [
      row.throughput.median,
      ...others.flatMap((rows) => rows.filter(sameGroup).map((match) => match.throughput.median)),
    ];
    const deviations = throughputByRun.map((value) => (Math.abs(value - row.throughput.median) / row.throughput.median) * 100);
    return {
      workload: row.workload,
      clients: row.clients,
      strategy: row.strategy,
      throughputByRun,
      maxDeviationPercent: round(Math.max(...deviations)),
    };
  });
}

export function renderComparison(results: ExperimentResult[]): string {
  const runs = results.map((result) => `run ${result.source.runId ?? "local"}`);
  const header = [
    `| Workload | Clients | Strategy | ${runs.map((run) => `Transfers/s, ${run}`).join(" | ")} | Largest deviation from the first run |`,
    `|---|---:|---|${runs.map(() => "---:").join("|")}|---:|`,
  ];
  const lines = compareRuns(results).map(
    (row) =>
      `| ${row.workload} | ${row.clients} | ${row.strategy} | ${row.throughputByRun.join(" | ")} | ${row.maxDeviationPercent}% |`,
  );
  return [...header, ...lines].join("\n");
}
