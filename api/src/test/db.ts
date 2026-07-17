import { prisma } from "../db/prisma.js";

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "ledger_entries", "transfers", "accounts" RESTART IDENTITY CASCADE`,
  );
}

export async function disconnectDb() {
  await prisma.$disconnect();
}
