import { randomUUID } from "node:crypto";
import type { Ledger } from "../application/ledger.js";
import { transferMoney } from "../application/transfer-money.js";
import { prisma } from "../db/prisma.js";

export async function createSandbox() {
  return prisma.sandbox.create({ data: { kind: "DEMO" } });
}

export async function createUserWithAccount(sandboxId: string, currency = "BRL") {
  const user = await prisma.user.create({ data: { sandboxId, displayName: "Test user" } });
  const account = await prisma.account.create({
    data: { name: "Main", currency, userId: user.id, sandboxId },
  });
  return { user, account };
}

export async function systemAccount(currency = "BRL") {
  return prisma.account.findFirstOrThrow({ where: { kind: "SYSTEM", currency } });
}

// Opening balances come out of the system account through a regular transfer.
export async function fund(ledger: Ledger, accountId: string, amount: bigint, currency = "BRL") {
  const system = await systemAccount(currency);
  return transferMoney(ledger, {
    actor: { type: "system" },
    fromAccountId: system.id,
    toAccountId: accountId,
    amount,
    idempotencyKey: `seed:${accountId}:${randomUUID()}`,
  });
}

export async function balanceOf(accountId: string): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(sum("amount"), 0)::text AS balance FROM "ledger_entries" WHERE "accountId" = ${accountId}`;
  return BigInt(row!.balance);
}

export async function globalSum(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(sum("amount"), 0)::text AS total FROM "ledger_entries"`;
  return BigInt(row!.total);
}
