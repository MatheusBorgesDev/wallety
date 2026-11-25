import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { transferMoney } from "../application/transfer-money.js";
import { InsufficientFunds } from "../domain/errors.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { ledgerStrategies, ledgerStrategyNames, type LedgerStrategyName } from "../infra/db/ledger-strategies.js";
import { createPessimisticLedger } from "../infra/db/pessimistic-ledger.js";
import { sqlStateOf } from "../infra/db/retry.js";
import { renderReport } from "./report.js";
import { percentile } from "./stats.js";
import type { CellResult, CorrectnessReport, ExperimentConfig, ExperimentResult } from "./types.js";
import { pickPair, workloads, type Workload, type WorkloadName } from "./workloads.js";

// Load experiment: runs every concurrency strategy under every workload and concurrency
// level against the database in DATABASE_URL, and writes the raw result as JSON.
//
// The database is wiped before every cell. Never point this at a database worth keeping.

const databaseUrl = requireEnv("DATABASE_URL");
const outputPath = process.env.EXPERIMENT_OUTPUT ?? "experiment-result.json";

const config: ExperimentConfig = {
  strategies: listFromEnv("EXPERIMENT_STRATEGIES", [...ledgerStrategyNames]) as LedgerStrategyName[],
  workloads: listFromEnv("EXPERIMENT_WORKLOADS", Object.keys(workloads)),
  clients: listFromEnv("EXPERIMENT_CLIENTS", ["4", "16", "32"]).map(Number),
  repetitions: Number(process.env.EXPERIMENT_REPETITIONS ?? 3),
  warmupMs: Number(process.env.EXPERIMENT_WARMUP_MS ?? 3000),
  durationMs: Number(process.env.EXPERIMENT_DURATION_MS ?? 10_000),
  // Large enough that a transfer is almost never refused for lack of funds: the experiment
  // measures the cost of concurrency control, not of the balance rule.
  openingBalance: "1000000000",
  maxTransferAmount: 100,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  return value ? value.split(",").map((item) => item.trim()) : fallback;
}

function connect(poolSize: number): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: poolSize }) });
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

type Participant = { userId: string; accountId: string };

type Seeded = {
  participants: Participant[];
  // Two accounts outside the workload, used by the overdraft probe after the measurement.
  probe: { source: Participant; destination: Participant };
};

const PROBE_BALANCE = 1000n;
const PROBE_AMOUNT = 100n;
const PROBE_TRANSFERS = 20;

async function resetAndSeed(admin: PrismaClient, workload: Workload): Promise<Seeded> {
  await admin.$executeRawUnsafe(
    `TRUNCATE "webhook_receipts", "outbox_events", "ledger_entries", "transfers" RESTART IDENTITY`,
  );
  await admin.$executeRawUnsafe(`DELETE FROM "accounts" WHERE "kind" = 'USER'`);
  await admin.$executeRawUnsafe(`DELETE FROM "users"`);
  await admin.$executeRawUnsafe(`DELETE FROM "sandboxes"`);

  const sandbox = await admin.sandbox.create({ data: { kind: "DEMO" } });
  const everyone: Participant[] = Array.from({ length: workload.accounts + 2 }, () => ({
    userId: randomUUID(),
    accountId: randomUUID(),
  }));
  const participants = everyone.slice(0, workload.accounts);
  const probe = { source: everyone.at(-2)!, destination: everyone.at(-1)! };
  await admin.user.createMany({
    data: everyone.map(({ userId }) => ({ id: userId, sandboxId: sandbox.id, displayName: "Load test user" })),
  });
  await admin.account.createMany({
    data: everyone.map(({ userId, accountId }) => ({
      id: accountId,
      name: "Main",
      currency: "BRL",
      userId,
      sandboxId: sandbox.id,
    })),
  });

  // Opening balances are regular transfers out of the system account, like everywhere else.
  const system = await admin.account.findFirstOrThrow({ where: { kind: "SYSTEM", currency: "BRL" } });
  const ledger = createPessimisticLedger(admin);
  const fund = (accountId: string, amount: bigint) =>
    transferMoney(ledger, {
      actor: { type: "system" },
      fromAccountId: system.id,
      toAccountId: accountId,
      amount,
      idempotencyKey: `seed:${accountId}`,
    });
  const queue = [...participants];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let next = queue.pop(); next; next = queue.pop()) {
        await fund(next.accountId, BigInt(config.openingBalance));
      }
    }),
  );
  await fund(probe.source.accountId, PROBE_BALANCE);
  await admin.$executeRawUnsafe(`VACUUM (ANALYZE)`);
  return { participants, probe };
}

// The workload accounts hold far more money than the load can move, so the load alone
// would not expose a strategy that lets an account overspend. The probe does: twenty
// simultaneous transfers of 100 out of an account holding 1000. A correct strategy
// accepts exactly ten and leaves the balance at zero.
async function probeOverdraft(
  prisma: PrismaClient,
  strategy: LedgerStrategyName,
  probe: Seeded["probe"],
): Promise<{ accepted: number; balance: string }> {
  const ledger = ledgerStrategies[strategy](prisma);
  const outcomes = await Promise.allSettled(
    Array.from({ length: PROBE_TRANSFERS }, () =>
      transferMoney(ledger, {
        actor: { type: "user", userId: probe.source.userId },
        fromAccountId: probe.source.accountId,
        toAccountId: probe.destination.accountId,
        amount: PROBE_AMOUNT,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  const [row] = await prisma.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(sum("amount"), 0)::text AS balance FROM "ledger_entries" WHERE "accountId" = ${probe.source.accountId}`;
  return { accepted: outcomes.filter((outcome) => outcome.status === "fulfilled").length, balance: row!.balance };
}

async function checkCorrectness(
  admin: PrismaClient,
  expectedTransfers: number,
  overdraftProbe: CorrectnessReport["overdraftProbe"],
): Promise<CorrectnessReport> {
  const [row] = await admin.$queryRaw<
    {
      ledger_sum: string;
      negative_user_accounts: number;
      transfers: number;
      transfers_without_two_entries: number;
      transfers_without_event: number;
    }[]
  >`
    SELECT
      (SELECT COALESCE(sum("amount"), 0)::text FROM "ledger_entries") AS ledger_sum,
      (SELECT count(*)::int FROM (
         SELECT e."accountId" FROM "ledger_entries" e
         JOIN "accounts" a ON a."id" = e."accountId" AND a."kind" = 'USER'
         GROUP BY e."accountId" HAVING sum(e."amount") < 0) negative) AS negative_user_accounts,
      (SELECT count(*)::int FROM "transfers") AS transfers,
      (SELECT count(*)::int FROM "transfers" t
         WHERE (SELECT count(*) FROM "ledger_entries" e WHERE e."transferId" = t."id") <> 2) AS transfers_without_two_entries,
      (SELECT count(*)::int FROM "transfers" t
         WHERE NOT EXISTS (SELECT 1 FROM "outbox_events" o WHERE o."transferId" = t."id")) AS transfers_without_event`;
  const report = {
    ledgerSum: row!.ledger_sum,
    negativeUserAccounts: row!.negative_user_accounts,
    transfers: row!.transfers,
    expectedTransfers,
    transfersWithoutTwoEntries: row!.transfers_without_two_entries,
    transfersWithoutEvent: row!.transfers_without_event,
    overdraftProbe,
  };
  return {
    ...report,
    ok:
      report.ledgerSum === "0" &&
      report.negativeUserAccounts === 0 &&
      report.transfers === expectedTransfers &&
      report.transfersWithoutTwoEntries === 0 &&
      report.transfersWithoutEvent === 0 &&
      overdraftProbe.accepted === Number(PROBE_BALANCE / PROBE_AMOUNT) &&
      overdraftProbe.balance === "0",
  };
}

async function runCell(
  admin: PrismaClient,
  strategy: LedgerStrategyName,
  workload: Workload,
  clients: number,
  repetition: number,
): Promise<CellResult> {
  const { participants, probe } = await resetAndSeed(admin, workload);
  const prisma = connect(clients);
  // Opens every connection of the pool before the clock starts.
  await Promise.all(Array.from({ length: clients }, () => prisma.$queryRaw`SELECT 1`));

  const latencies: number[] = [];
  const failuresByCode: Record<string, number> = {};
  const retriesByCode: Record<string, number> = {};
  let rejected = 0;
  let committedAfterRetry = 0;
  // Every transfer that committed, warm-up included: the ledger must hold exactly these.
  let committedOverall = 0;

  const measureFrom = performance.now() + config.warmupMs;
  const measureUntil = measureFrom + config.durationMs;
  const measured = (now: number) => now >= measureFrom && now <= measureUntil;

  async function client(): Promise<void> {
    let retriesOfCurrentTransfer = 0;
    // Each client owns its ledger, so it can tell how many retries its current transfer needed.
    const ledger = ledgerStrategies[strategy](prisma, {
      onRetry: (sqlState) => {
        retriesOfCurrentTransfer += 1;
        if (measured(performance.now())) {
          increment(retriesByCode, sqlState);
        }
      },
    });
    while (performance.now() < measureUntil) {
      const [fromIndex, toIndex] = pickPair(workload, Math.random);
      const from = participants[fromIndex]!;
      const to = participants[toIndex]!;
      retriesOfCurrentTransfer = 0;
      const startedAt = performance.now();
      try {
        await transferMoney(ledger, {
          actor: { type: "user", userId: from.userId },
          fromAccountId: from.accountId,
          toAccountId: to.accountId,
          amount: BigInt(1 + Math.floor(Math.random() * config.maxTransferAmount)),
          idempotencyKey: randomUUID(),
        });
        const finishedAt = performance.now();
        committedOverall += 1;
        if (measured(finishedAt)) {
          latencies.push(finishedAt - startedAt);
          if (retriesOfCurrentTransfer > 0) {
            committedAfterRetry += 1;
          }
        }
      } catch (error) {
        if (!measured(performance.now())) {
          continue;
        }
        if (error instanceof InsufficientFunds) {
          rejected += 1;
        } else {
          increment(failuresByCode, sqlStateOf(error) ?? "other");
        }
      }
    }
  }

  await Promise.all(Array.from({ length: clients }, client));
  const overdraftProbe = await probeOverdraft(prisma, strategy, probe);
  await prisma.$disconnect();

  const sum = (counter: Record<string, number>) => Object.values(counter).reduce((total, count) => total + count, 0);
  const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  return {
    strategy,
    workload: workload.name,
    clients,
    repetition,
    measuredMs: config.durationMs,
    committed: latencies.length,
    rejected,
    failed: sum(failuresByCode),
    failuresByCode,
    retries: sum(retriesByCode),
    retriesByCode,
    committedAfterRetry,
    throughputPerSecond: round(latencies.length / (config.durationMs / 1000))!,
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(percentile(latencies, 100)),
    },
    correctness: await checkCorrectness(
      admin,
      // Opening balances of the workload accounts and of the probe account, then the load, then the probe.
      participants.length + 1 + committedOverall + overdraftProbe.accepted,
      overdraftProbe,
    ),
  };
}

function currentCommit(): string | null {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function describeEnvironment(admin: PrismaClient): Promise<ExperimentResult["environment"]> {
  const [version] = await admin.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
  const settings = await admin.$queryRaw<{ name: string; setting: string }[]>`
    SELECT name, current_setting(name) AS setting FROM pg_settings
    WHERE name IN ('shared_buffers', 'synchronous_commit', 'fsync', 'max_connections',
                   'default_transaction_isolation', 'max_pred_locks_per_transaction', 'deadlock_timeout')
    ORDER BY name`;
  const image = process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ""}`.trim() : null;
  return {
    postgresVersion: version!.server_version,
    postgresSettings: Object.fromEntries(settings.map(({ name, setting }) => [name, setting])),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    runnerImage: image,
  };
}

async function main(): Promise<void> {
  const admin = connect(10);
  const startedAt = new Date();
  const environment = await describeEnvironment(admin);
  const cells: CellResult[] = [];
  const total =
    config.repetitions * config.workloads.length * config.clients.length * config.strategies.length;

  let position = 0;
  for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
    for (const workloadName of config.workloads) {
      const workload = workloads[workloadName as WorkloadName];
      if (!workload) {
        throw new Error(`Unknown workload: ${workloadName}`);
      }
      for (const clients of config.clients) {
        // The order of the strategies rotates from one group to the next, so that no
        // strategy always runs first or last.
        const rotation = position % config.strategies.length;
        const order = [...config.strategies.slice(rotation), ...config.strategies.slice(0, rotation)];
        position += 1;
        for (const strategy of order) {
          const cell = await runCell(admin, strategy, workload, clients, repetition);
          cells.push(cell);
          console.log(
            `[${cells.length}/${total}] rep ${repetition} ${workload.name} clients=${clients} ${strategy}: ` +
              `${cell.throughputPerSecond}/s p50=${cell.latencyMs.p50}ms p99=${cell.latencyMs.p99}ms ` +
              `retries=${cell.retries} failed=${cell.failed} correct=${cell.correctness.ok}`,
          );
        }
      }
    }
  }

  const result: ExperimentResult = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      commit: currentCommit(),
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    environment,
    config,
    cells,
  };
  await admin.$disconnect();

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n${renderReport(result)}`);

  const incorrect = cells.filter((cell) => !cell.correctness.ok);
  if (incorrect.length > 0) {
    console.error(`${incorrect.length} cell(s) left the ledger in an incorrect state.`);
    process.exitCode = 1;
  }
}

await main();
