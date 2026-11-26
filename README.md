# Wallety

[![CI](https://github.com/MatheusBorgesDev/wallety/actions/workflows/ci.yml/badge.svg)](https://github.com/MatheusBorgesDev/wallety/actions/workflows/ci.yml)

A digital wallet API built on a double-entry ledger. The goal is an API where money is never created,
destroyed or corrupted, even under concurrent transfers and repeated requests, with a small web app on top.

**Status: work in progress.** Nothing is deployed yet. This README describes what exists today and is updated
as features land.

## What exists today

- A versioned REST API (`/v1`) on Express 5 and TypeScript: registration and login, accounts, statements,
  transfers and webhook events. Every route is declared once, with zod schemas, and that declaration validates
  the request, registers the handler and generates the OpenAPI 3.1 document. Swagger UI at `/docs`.
- Authorization proven per route: for every `/v1` route that takes a signed-in user, an integration test shows
  that one user cannot read or move what belongs to another, and that someone else's resource is answered
  exactly like one that does not exist (`404`). A route missing from that matrix fails the build.
- Argon2id password hashes, short-lived bearer tokens, and rate limits on login and registration counted in
  PostgreSQL, answered with `429` and `Retry-After`.
- `GET /health` (checks the database) and `GET /health/live` (does not).
- Structured JSON logs, one line per request with a correlation id; headers and bodies are never logged.
- A multi-stage Dockerfile whose runtime image has no shell and runs as a non-root user.
- A double-entry ledger: transfers with idempotency keys and three interchangeable concurrency strategies
  (two forms of pessimistic locking, and `SERIALIZABLE` with retries), all held to the same test suites. Money enters only through a
  system account, and the database itself rejects a transfer whose entries do not sum to zero.
- Outgoing webhooks through a transactional outbox: every posted transfer writes an event in the same
  transaction, and a separate process delivers it with retries, an HMAC signature and a stable event id.
- Unit tests, and integration tests that run against a real PostgreSQL database.
- CI on GitHub Actions: lint, typecheck, unit tests, integration tests and a container build that starts
  the whole stack, on every pull request.

## What is planned for v1

A demo login whose data removes itself, a web app and continuous deployment.

## SERIALIZABLE versus pessimistic locking, measured

The three concurrency strategies were run under load on a GitHub-hosted runner (4 vCPUs, PostgreSQL 16.16 in
a service container), twice, on 2026-11-25. Median committed transfers per second with 16 clients, from run
[45720471786](https://github.com/MatheusBorgesDev/wallety/actions/runs/45720471786):

| Workload | Lock both accounts | Lock the debited account | `SERIALIZABLE` with retries |
|---|---:|---:|---:|
| High contention (4 accounts) | 280.4 | 399 | 126.1, with 320.8 retries per 100 transfers |
| Low contention (1000 accounts) | 456.5 | 501 | 536.3, with 2.3 retries per 100 transfers |
| Mixed | 426.1 | 488.1 | 205.4, with 162.2 retries per 100 transfers |

In both runs, locking only the debited account beat locking both in every group, and `SERIALIZABLE` was the
slowest strategy whenever transfers concentrated on a few accounts. Under low contention the strategies were
closer to each other than one run was to the other, so no ranking is claimed there. Median throughput of a
group moved by up to 31.6% between the two runs. Method, full tables, variation and limits:
[docs/concurrency-experiment.md](docs/concurrency-experiment.md).

## Running locally

With Docker only, one command starts the database, applies the migrations and starts the API and the webhook
delivery process:

```sh
docker compose up --build
curl http://localhost:3000/health
```

Then open http://localhost:3000/docs: register through `POST /v1/auth/register`, paste the returned
`accessToken` into **Authorize**, and try the other routes. A new user starts with a funded account and a
sample recipient to transfer to.

Set `API_PORT` to use another host port.

For development, with Node 24 and Docker:

```sh
docker compose up -d postgres
cd api
cp .env.example .env   # then set USER, PASSWORD and the two secrets
npm ci
npm run generate
npx prisma migrate deploy
npm run dev
```

```sh
curl http://localhost:3000/health
```

## Tests

```sh
cd api
npm run lint
npm run typecheck
npm run test:unit          # no database needed
npm run test:integration   # needs the postgres container running
```

The transfer suites run once per concurrency strategy.

## How it was built

I built this project by directing AI coding agents.

## License

[MIT](LICENSE)
