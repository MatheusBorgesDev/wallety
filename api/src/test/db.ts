import { prisma } from "../db/prisma.js";

// Removes everything a test may have created, in dependency order, and keeps the
// SYSTEM accounts that the migrations seed.
export async function resetDb() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`DELETE FROM "rate_limit_hits"`),
    prisma.$executeRawUnsafe(`DELETE FROM "webhook_receipts"`),
    prisma.$executeRawUnsafe(`DELETE FROM "outbox_events"`),
    prisma.$executeRawUnsafe(`DELETE FROM "ledger_entries"`),
    prisma.$executeRawUnsafe(`DELETE FROM "transfers"`),
    prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE "kind" = 'USER'`),
    prisma.$executeRawUnsafe(`DELETE FROM "users"`),
    prisma.$executeRawUnsafe(`DELETE FROM "sandboxes"`),
  ]);
}

// The ids of everything a sandbox owns, to check later that none of it is left.
export async function rowsOfSandbox(sandboxId: string) {
  const [row] = await prisma.$queryRaw<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM "sandboxes" WHERE "id" = ${sandboxId}) AS "sandboxes",
      (SELECT count(*)::int FROM "users" WHERE "sandboxId" = ${sandboxId}) AS "users",
      (SELECT count(*)::int FROM "accounts" WHERE "sandboxId" = ${sandboxId}) AS "accounts",
      (SELECT count(*)::int FROM "outbox_events" WHERE "sandboxId" = ${sandboxId}) AS "outboxEvents",
      (SELECT count(*)::int FROM "webhook_receipts" WHERE "sandboxId" = ${sandboxId}) AS "webhookReceipts"`;
  return row!;
}

export async function disconnectDb() {
  await prisma.$disconnect();
}
