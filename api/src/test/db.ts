import { prisma } from "../db/prisma.js";

// Removes everything a test may have created, in dependency order, and keeps the
// SYSTEM accounts that the migrations seed.
export async function resetDb() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`DELETE FROM "ledger_entries"`),
    prisma.$executeRawUnsafe(`DELETE FROM "transfers"`),
    prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE "kind" = 'USER'`),
    prisma.$executeRawUnsafe(`DELETE FROM "users"`),
    prisma.$executeRawUnsafe(`DELETE FROM "sandboxes"`),
  ]);
}

export async function disconnectDb() {
  await prisma.$disconnect();
}
