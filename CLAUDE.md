# Wallety

Digital wallet API built on a double-entry ledger, with a small web app on top.

## Layout
- `api/`: Node 24, Express 5, TypeScript, PostgreSQL through Prisma 7. Dependency versions are pinned.
- `api/src/domain`, `application`, `infra`: pure rules, use cases and their ports, adapters. The domain and
  application layers import nothing that does I/O; structural tests enforce it.
- `api/src/http`: the route declaration (`route.ts`), OpenAPI generation, Swagger UI, authentication and the
  common error shape. `api/src/routes`: the route declarations themselves.
- `api/src/experiment`: load harness that compares the concurrency strategies; results in `experiments/`.
- `api/src/webhooks`, `api/src/worker.ts`: outbox delivery, run as a separate process from the same image.
- `infra/`: one-time cloud setup scripts.
- `.github/workflows/`: CI and deployment.

## Commands (run in `api/`)
- `npm run lint`, `npm run typecheck`
- `npm run test:unit`: no database needed.
- `npm run test:integration`: needs `docker compose up -d postgres`. Integration tests are named `*.int.test.ts`.
- `npm run generate`: after any change to `prisma/schema.prisma`.
- `npm run experiment`: load experiment over the concurrency strategies. It wipes the database in `DATABASE_URL`.
- `docker compose up --build` (repository root): database, migrations and API. `API_PORT` sets the host port.

## Conventions
- Code, comments, test descriptions and documentation are written in English.
- Business rules are test-driven: failing test, code, passing test, commit.
- Integration and concurrency tests run against a real PostgreSQL database, never a mock.
- A guard (structural test, CI check) only counts after it was broken on purpose and seen failing.
- `main` is protected: work happens on a branch and lands through a pull request with green checks.
- Documentation in this repository describes the project. Work notes, task lists and status reports stay out of it.
- A route is declared with `defineRoute` and mounted through `mountRoutes`, never with `app.get` directly and
  never on a mounted router: tests read the routes back from Express and fail on one that is missing from the
  OpenAPI document or, under `/v1`, from the authorization matrix (`api/src/test/authorization-matrix.ts`).
- Queries take the caller's identity and filter by it; someone else's resource is a `404`, never a `403`.
- Money crosses the API as a string of an integer in minor units.
- Removal is by whole sandbox, through `api/src/infra/db/purge.ts`, on the cleanup login. A new table that
  holds sandbox data needs its `GRANT`s in the migration and a `DELETE` there.
- Never state more than the facts support. Numbers are measured, with date and method, never estimated.

## Domain rules
- Money is a `BigInt` in minor units (cents), never a float.
- Double-entry ledger: the entries of every transfer sum to zero.
- A balance is derived from the ledger entries; it is never a stored column.
- Concurrency: pessimistic locking (`SELECT ... FOR UPDATE`) with a consistent lock order is the default.
  `api/src/infra/db/ledger-strategies.ts` lists every strategy; the transfer suites run once per strategy.
- Idempotency: one key per transfer.
- Transfers are same-currency only in v1.
- The ledger never creates money: an opening balance is a regular transfer from a system account.
