#!/usr/bin/env sh
# Applies the migrations to the test database before the integration tests.
set -eu
DATABASE_URL="${TEST_DATABASE_URL:-postgresql://wallety:wallety@localhost:5433/wallety_test?schema=public}"
export DATABASE_URL
exec npx prisma migrate deploy
