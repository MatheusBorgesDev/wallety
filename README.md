# Wallety

[![CI](https://github.com/MatheusBorgesDev/wallety/actions/workflows/ci.yml/badge.svg)](https://github.com/MatheusBorgesDev/wallety/actions/workflows/ci.yml)

A digital wallet API built on a double-entry ledger. The goal is an API where money is never created,
destroyed or corrupted, even under concurrent transfers and repeated requests, with a small web app on top.

**Status: work in progress.** Nothing is deployed yet. This README describes what exists today and is updated
as each phase lands.

## What exists today

- An Express 5 + TypeScript API with a `GET /health` endpoint that checks the database.
- The first ledger schema (accounts, transfers, ledger entries) as a Prisma migration on PostgreSQL.
- Unit tests, and integration tests that run against a real PostgreSQL database.
- CI on GitHub Actions: lint, typecheck, unit tests and integration tests on every pull request.

## What is planned for v1

Double-entry transfers with pessimistic locking and idempotency, a concurrency test suite, a versioned REST API
with a generated OpenAPI document, authorization tests for every endpoint, a demo login, a container image,
continuous deployment, and a measured comparison between `SERIALIZABLE` isolation and pessimistic locking.

## Running locally

Requirements: Node 24 and Docker.

```sh
docker compose up -d postgres
cd api
cp .env.example .env   # then set USER and PASSWORD to the values in docker-compose.yml
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

## How it was built

I built this project by directing AI coding agents.

## License

[MIT](LICENSE)
