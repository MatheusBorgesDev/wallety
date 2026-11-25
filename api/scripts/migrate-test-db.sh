#!/usr/bin/env sh
# Applies the migrations to the test database and creates the local login roles,
# before the integration tests.
set -eu
DATABASE_URL="${TEST_DATABASE_URL:-postgresql://wallety:wallety@localhost:5433/wallety_test?schema=public}"
export DATABASE_URL
npx prisma migrate deploy
exec npx prisma db execute --file prisma/local/login-roles.sql
