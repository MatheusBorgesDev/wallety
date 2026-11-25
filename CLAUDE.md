# Wallety

Digital wallet API built on a double-entry ledger, with a small web app on top.

## Layout
- `api/`: Node 24, Express 5, TypeScript, PostgreSQL through Prisma 7. Dependency versions are pinned.
- `infra/`: one-time cloud setup scripts.
- `.github/workflows/`: CI and deployment.

## Commands (run in `api/`)
- `npm run lint`, `npm run typecheck`
- `npm run test:unit`: no database needed.
- `npm run test:integration`: needs `docker compose up -d postgres`. Integration tests are named `*.int.test.ts`.
- `npm run generate`: after any change to `prisma/schema.prisma`.
- `docker compose up --build` (repository root): database, migrations and API. `API_PORT` sets the host port.

## Conventions
- Code, comments, test descriptions and documentation are written in English.
- Business rules are test-driven: failing test, code, passing test, commit.
- Integration and concurrency tests run against a real PostgreSQL database, never a mock.
- A guard (structural test, CI check) only counts after it was broken on purpose and seen failing.
- `main` is protected: work happens on a branch and lands through a pull request with green checks.
- Documentation in this repository describes the project. Work notes, task lists and status reports stay out of it.
- Never state more than the facts support. Numbers are measured, with date and method, never estimated.

## Domain rules
- Money is a `BigInt` in minor units (cents), never a float.
- Double-entry ledger: the entries of every transfer sum to zero.
- A balance is derived from the ledger entries; it is never a stored column.
- Concurrency: pessimistic locking (`SELECT ... FOR UPDATE`) with a consistent lock order.
- Idempotency: one key per transfer.
- Transfers are same-currency only in v1.
- The ledger never creates money: an opening balance is a regular transfer from a system account.
