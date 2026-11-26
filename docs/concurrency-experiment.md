# Concurrency experiment: SERIALIZABLE versus pessimistic locking

A transfer reads the balance of the debited account and then writes two ledger entries and one outbox event.
Two transfers that debit the same account at the same time must not both pass the balance check on the same
balance. This experiment measures three ways of guaranteeing that, on the same code path and the same database.

## Strategies

All three implement the same port (`api/src/application/ledger.ts`); the use case does not know which one it
is running on. They are listed in `api/src/infra/db/ledger-strategies.ts`.

| Name | Isolation level | What it locks | On conflict |
|---|---|---|---|
| `pessimistic-both` | READ COMMITTED | Both user accounts, `SELECT ... FOR UPDATE`, in ascending id order | Waits for the lock |
| `pessimistic-debit` | READ COMMITTED | The debited account only, `SELECT ... FOR NO KEY UPDATE` | Waits for the lock |
| `serializable` | SERIALIZABLE | Nothing explicit | PostgreSQL aborts one transaction (`40001`); the unit of work runs again, up to 30 attempts, after a random wait under a ceiling that doubles from 2 ms to 50 ms |

Before being measured, every strategy has to pass the same integration suites: no overspending under twenty
simultaneous debits, no deadlock on crossing transfers, one transfer for ten simultaneous requests with the
same idempotency key, and an outbox event if and only if the transfer commits.

## Method

| Aspect | Value |
|---|---|
| Transaction measured | The complete transfer: idempotency key, account lookup, balance check, two ledger entries, one outbox event, and the deferred constraint triggers at commit |
| Workloads | `high-contention`: both accounts drawn from the same 4. `low-contention`: both drawn uniformly from 1000. `mixed`: half of the transfers inside 4 hot accounts, the rest uniform over 1000 |
| Load | Closed loop: 4, 16 and 32 clients, each sending its next transfer as soon as the previous one returns. The connection pool has one connection per client |
| Timing | 3 s of warm-up, not measured, then 10 s measured. 3 repetitions of every cell |
| Order | Within each workload and concurrency level the order of the strategies rotates, so none always runs first |
| Starting state | The database is emptied and seeded again before every cell, then `VACUUM (ANALYZE)` |
| Throughput | Transfers committed inside the measured window, per second |
| Latency | Per committed transfer, from the call to the use case until it returns, retries and their waits included. Nearest-rank percentiles |
| Retries | Times a unit of work was run again, per 100 committed transfers |
| Failed | Transfers that ended in an error. In these runs every one of them was a `serializable` transfer that used up its 30 attempts |
| Aggregation | The tables show the median of the 3 repetitions; throughput also shows the lowest and highest repetition |
| Correctness | After every cell: the ledger sums to zero, no user account is negative, every transfer has two entries and one event, the number of transfers matches the number the clients saw commit, and an overdraft probe (twenty simultaneous transfers of 100 from an account holding 1000) accepts exactly ten. A cell that fails any check is reported as incorrect |
| Where | The `Concurrency experiment` workflow on a GitHub-hosted `ubuntu-latest` runner, with PostgreSQL 16 in a service container on the same machine, default settings (`shared_buffers` 128 MB, `fsync` and `synchronous_commit` on) |

Workload accounts start with far more money than the load can move, so no transfer in these runs was refused
for insufficient funds: the experiment measures concurrency control, not the balance rule. That is also why the
overdraft probe exists. With such balances the other checks cannot tell a strategy that allows overspending
from one that does not; the probe was verified against two deliberately broken strategies, and flagged both.

## Results

The workflow ran twice on commit `b9307d6`. All 81 cells of both runs passed the correctness checks. The raw
results are in [`experiments/results`](../experiments/results).

### Run 45720471786

Measured on 2026-11-25 in GitHub Actions run 45720471786, commit b9307d6. PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1), Node v24.22.3, 4 CPUs (AMD EPYC 7763 64-Core Processor), 15.6 GB of memory, runner image ubuntu26 20261116.202.1. 3 repetition(s) of 10 s each, after 3 s of warm-up.

| Workload | Clients | Strategy | Transfers/s, median (min–max) | p50 ms | p95 ms | p99 ms | Retries per 100 transfers | Failed |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| high-contention | 4 | pessimistic-both | 216.1 (214–219.8) | 18.1 | 31.1 | 37.6 | 0 | 0 |
| high-contention | 4 | pessimistic-debit | 281.3 (275.1–282.9) | 13.1 | 23.6 | 28.6 | 0 | 0 |
| high-contention | 4 | serializable | 186.4 (147.9–219.7) | 5.1 | 77.4 | 361.5 | 74.7 | 31 |
| high-contention | 16 | pessimistic-both | 280.4 (263.8–321.9) | 35.4 | 120.6 | 134.1 | 0 | 0 |
| high-contention | 16 | pessimistic-debit | 399 (382–441.9) | 34.1 | 87.3 | 104.7 | 0 | 0 |
| high-contention | 16 | serializable | 126.1 (113–130.1) | 56.9 | 462 | 868.5 | 320.8 | 7 |
| high-contention | 32 | pessimistic-both | 306.8 (287.4–306.8) | 138.4 | 230.6 | 256.8 | 0 | 0 |
| high-contention | 32 | pessimistic-debit | 456.4 (445.2–462.5) | 58.5 | 158.6 | 194.5 | 0 | 0 |
| high-contention | 32 | serializable | 73 (62–73.3) | 258.9 | 1335.9 | 1781.3 | 644.5 | 44 |
| low-contention | 4 | pessimistic-both | 451.4 (450.9–452.2) | 8.9 | 10.9 | 13 | 0 | 0 |
| low-contention | 4 | pessimistic-debit | 494.4 (490.3–496.3) | 8.1 | 10 | 11.9 | 0 | 0 |
| low-contention | 4 | serializable | 541.5 (536.4–544.4) | 7.3 | 9.2 | 12.1 | 0.6 | 0 |
| low-contention | 16 | pessimistic-both | 456.5 (450.2–456.8) | 31.2 | 56.5 | 62.5 | 0 | 0 |
| low-contention | 16 | pessimistic-debit | 501 (499.7–506.3) | 28.4 | 51 | 56.4 | 0 | 0 |
| low-contention | 16 | serializable | 536.3 (534.6–543.3) | 25.9 | 48.2 | 73.4 | 2.3 | 0 |
| low-contention | 32 | pessimistic-both | 445.1 (444.8–445.7) | 66.7 | 111.7 | 131.9 | 0 | 0 |
| low-contention | 32 | pessimistic-debit | 492.4 (491.4–496) | 60.8 | 98.1 | 117.6 | 0 | 0 |
| low-contention | 32 | serializable | 510.6 (505.9–523.9) | 55.4 | 106.8 | 167.1 | 4.8 | 0 |
| mixed | 4 | pessimistic-both | 428.1 (425.7–428.2) | 8.8 | 14.1 | 17.2 | 0 | 0 |
| mixed | 4 | pessimistic-debit | 480.4 (476.8–485.6) | 8.1 | 11.3 | 13.3 | 0 | 0 |
| mixed | 4 | serializable | 351.9 (333.1–352.4) | 7.3 | 32.2 | 70.1 | 47.3 | 0 |
| mixed | 16 | pessimistic-both | 426.1 (423.9–432.2) | 13 | 128.4 | 151.8 | 0 | 0 |
| mixed | 16 | pessimistic-debit | 488.1 (483.2–491.6) | 22.4 | 83.8 | 108.1 | 0 | 0 |
| mixed | 16 | serializable | 205.4 (204.2–207.4) | 21.7 | 355.5 | 730.6 | 162.2 | 4 |
| mixed | 32 | pessimistic-both | 427.5 (422–430.4) | 12.9 | 288.1 | 330.3 | 0 | 0 |
| mixed | 32 | pessimistic-debit | 492.8 (487.6–493.5) | 26.9 | 214.8 | 290.4 | 0 | 0 |
| mixed | 32 | serializable | 124.7 (122.5–125.8) | 48 | 1114.2 | 1708.1 | 331.1 | 41 |

### Run 45720506403

Measured on 2026-11-25 in GitHub Actions run 45720506403, commit b9307d6. PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1), Node v24.22.3, 4 CPUs (AMD EPYC 9V74 80-Core Processor), 15.6 GB of memory, runner image ubuntu26 20261116.202.1. 3 repetition(s) of 10 s each, after 3 s of warm-up.

| Workload | Clients | Strategy | Transfers/s, median (min–max) | p50 ms | p95 ms | p99 ms | Retries per 100 transfers | Failed |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| high-contention | 4 | pessimistic-both | 202.3 (199.9–283.3) | 15.3 | 28.6 | 120.1 | 0 | 0 |
| high-contention | 4 | pessimistic-debit | 303.6 (299.4–390.7) | 10.3 | 22.1 | 41.6 | 0 | 0 |
| high-contention | 4 | serializable | 194.1 (152.6–257.8) | 3.6 | 6.7 | 32.5 | 61.7 | 93 |
| high-contention | 16 | pessimistic-both | 275.8 (214.5–302.8) | 59 | 141.6 | 227.6 | 0 | 0 |
| high-contention | 16 | pessimistic-debit | 473.9 (465.1–487.2) | 27.6 | 74.5 | 127.3 | 0 | 0 |
| high-contention | 16 | serializable | 164.1 (147.7–172.2) | 38.7 | 405.7 | 686.7 | 324.6 | 9 |
| high-contention | 32 | pessimistic-both | 239 (185.3–325.3) | 127.6 | 435.8 | 591.7 | 0 | 0 |
| high-contention | 32 | pessimistic-debit | 460.6 (435.4–492.6) | 52.6 | 196 | 331.1 | 0 | 0 |
| high-contention | 32 | serializable | 58.3 (53.6–70.7) | 258.7 | 1100.2 | 1319.8 | 1123.8 | 206 |
| low-contention | 4 | pessimistic-both | 490.2 (254.5–526.6) | 6.7 | 9.8 | 56.8 | 0 | 0 |
| low-contention | 4 | pessimistic-debit | 580.6 (378–628.2) | 6 | 8.4 | 27.3 | 0 | 0 |
| low-contention | 4 | serializable | 605.8 (472.9–698.7) | 5.5 | 8.5 | 33.4 | 0.6 | 0 |
| low-contention | 16 | pessimistic-both | 513 (448.8–581.8) | 23.7 | 57.4 | 161.1 | 0 | 0 |
| low-contention | 16 | pessimistic-debit | 630 (571.8–642.8) | 21.2 | 39.6 | 100.5 | 0 | 0 |
| low-contention | 16 | serializable | 515.3 (450.9–647.1) | 19.3 | 69.8 | 180.2 | 3.9 | 0 |
| low-contention | 32 | pessimistic-both | 491.5 (421.2–544.3) | 50.6 | 137.2 | 217.4 | 0 | 0 |
| low-contention | 32 | pessimistic-debit | 524.9 (432.5–547) | 45.8 | 154 | 246.9 | 0 | 0 |
| low-contention | 32 | serializable | 598.5 (574.7–607.7) | 41.1 | 114.8 | 216.4 | 10.3 | 0 |
| mixed | 4 | pessimistic-both | 362 (245.8–505.7) | 6.7 | 16.9 | 151.8 | 0 | 0 |
| mixed | 4 | pessimistic-debit | 425.1 (393.9–626.9) | 6.1 | 10.2 | 111.5 | 0 | 0 |
| mixed | 4 | serializable | 317.9 (281.5–449) | 5.4 | 43.9 | 141.6 | 51.1 | 0 |
| mixed | 16 | pessimistic-both | 433 (368.1–482.7) | 10 | 115.3 | 307.7 | 0 | 0 |
| mixed | 16 | pessimistic-debit | 594.6 (378.4–642.6) | 17 | 72.6 | 113.8 | 0 | 0 |
| mixed | 16 | serializable | 265.3 (255.1–265.9) | 14.9 | 299.1 | 617.9 | 167.2 | 12 |
| mixed | 32 | pessimistic-both | 512.7 (444.9–549.4) | 9.6 | 243.3 | 317.2 | 0 | 0 |
| mixed | 32 | pessimistic-debit | 638 (556.5–653.1) | 20.7 | 165 | 219.8 | 0 | 0 |
| mixed | 32 | serializable | 164.1 (116.8–164.2) | 36.2 | 863.3 | 1356.7 | 342.9 | 98 |

## Variation between the two runs

Median throughput of each group in each run:

| Workload | Clients | Strategy | Transfers/s, run 45720471786 | Transfers/s, run 45720506403 | Largest deviation from the first run |
|---|---:|---|---:|---:|---:|
| high-contention | 4 | pessimistic-both | 216.1 | 202.3 | 6.4% |
| high-contention | 4 | pessimistic-debit | 281.3 | 303.6 | 7.9% |
| high-contention | 4 | serializable | 186.4 | 194.1 | 4.1% |
| high-contention | 16 | pessimistic-both | 280.4 | 275.8 | 1.6% |
| high-contention | 16 | pessimistic-debit | 399 | 473.9 | 18.8% |
| high-contention | 16 | serializable | 126.1 | 164.1 | 30.1% |
| high-contention | 32 | pessimistic-both | 306.8 | 239 | 22.1% |
| high-contention | 32 | pessimistic-debit | 456.4 | 460.6 | 0.9% |
| high-contention | 32 | serializable | 73 | 58.3 | 20.1% |
| low-contention | 4 | pessimistic-both | 451.4 | 490.2 | 8.6% |
| low-contention | 4 | pessimistic-debit | 494.4 | 580.6 | 17.4% |
| low-contention | 4 | serializable | 541.5 | 605.8 | 11.9% |
| low-contention | 16 | pessimistic-both | 456.5 | 513 | 12.4% |
| low-contention | 16 | pessimistic-debit | 501 | 630 | 25.7% |
| low-contention | 16 | serializable | 536.3 | 515.3 | 3.9% |
| low-contention | 32 | pessimistic-both | 445.1 | 491.5 | 10.4% |
| low-contention | 32 | pessimistic-debit | 492.4 | 524.9 | 6.6% |
| low-contention | 32 | serializable | 510.6 | 598.5 | 17.2% |
| mixed | 4 | pessimistic-both | 428.1 | 362 | 15.4% |
| mixed | 4 | pessimistic-debit | 480.4 | 425.1 | 11.5% |
| mixed | 4 | serializable | 351.9 | 317.9 | 9.7% |
| mixed | 16 | pessimistic-both | 426.1 | 433 | 1.6% |
| mixed | 16 | pessimistic-debit | 488.1 | 594.6 | 21.8% |
| mixed | 16 | serializable | 205.4 | 265.3 | 29.2% |
| mixed | 32 | pessimistic-both | 427.5 | 512.7 | 19.9% |
| mixed | 32 | pessimistic-debit | 492.8 | 638 | 29.5% |
| mixed | 32 | serializable | 124.7 | 164.1 | 31.6% |

The two runs landed on runners with different CPU models (AMD EPYC 7763 and AMD EPYC 9V74). The median
throughput of a group moved by up to 31.6% from one run to the other, with a median of 12.4% over the 27
groups. The second run was also less steady within itself: the gap between its lowest and highest repetition
is wider in most groups.

## What holds in both runs

- `pessimistic-debit` had a higher throughput than `pessimistic-both` in all 18 groups (9 per run).
- Under `high-contention` and `mixed`, `serializable` had the lowest throughput in all 12 groups, and its
  throughput fell as clients were added: 186.4, 126.1 and 73 transfers per second with 4, 16 and 32 clients
  under `high-contention` in the first run, and 194.1, 164.1 and 58.3 in the second. The pessimistic strategies
  did not show that fall.
- In those two workloads `serializable` retried between 47.3 and 1123.8 times per 100 committed transfers, its
  p99 latency with 32 clients was between 1.3 s and 1.8 s, and 127 transfers in the first run and 418 in the
  second used up their 30 attempts and failed. No transfer failed under either pessimistic strategy.
- Under `low-contention`, `serializable` retried between 0.6 and 10.3 times per 100 committed transfers and no
  transfer failed.

## What does not hold in both runs

- Under `low-contention`, `serializable` had the highest throughput at all three concurrency levels in the first
  run, but only at two of the three in the second. The differences between strategies in this workload are
  smaller than the variation between runs, so these runs do not rank the strategies under low contention.
- The size of any gap. With differences between runs of this order, the tables support the ordering described
  above, not a precise ratio.

## Limits

- Shared, virtualized hardware: 4 vCPUs, with the load generator and the database on the same machine and no
  network between them. This is not production hardware, and absolute numbers do not transfer to it.
- PostgreSQL with default settings and `fsync` on, so the speed of the runner's disk is part of every number.
- Ten seconds per cell and three repetitions. Effects that take longer to appear, such as table growth or
  autovacuum, are outside the window.
- Tables are small at the start of each cell (at most 1002 user accounts). SERIALIZABLE tracks reads by index page
  when it can, so a larger ledger may conflict less, or more, than what was measured here. Not measured.
- One retry policy for `serializable`. Another number of attempts or another backoff would change its
  throughput, its tail latency and its failure count.
- A closed loop measures how fast each strategy clears work that is always waiting. It says nothing about
  latency at a fixed arrival rate below saturation.
- The pessimistic strategies differ in two things at once, the number of accounts locked and the lock mode
  (`FOR UPDATE` and `FOR NO KEY UPDATE`). The experiment does not separate the two.

## Reproducing

On GitHub: run the `Concurrency experiment` workflow; the table appears on the run page and the JSON is
attached as an artifact.

Locally, against a database that can be wiped:

```sh
docker compose up -d postgres
cd api
export DATABASE_URL='postgresql://wallety:wallety@localhost:5433/wallety_test?schema=public'
npx prisma migrate deploy
npm run experiment
npm run experiment:report -- experiment-result.json
```

`EXPERIMENT_DURATION_MS`, `EXPERIMENT_WARMUP_MS`, `EXPERIMENT_REPETITIONS`, `EXPERIMENT_CLIENTS`,
`EXPERIMENT_WORKLOADS` and `EXPERIMENT_STRATEGIES` override the defaults.
