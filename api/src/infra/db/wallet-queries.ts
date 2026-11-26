import { ensureCanOpenAccount } from "../../domain/opening.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

// The read side of the API, and the two writes that are not ledger transfers. Every
// function takes the caller's identity and puts it in the WHERE clause: a row that belongs
// to someone else is simply not found, which is what the API then reports.

export type AccountView = { id: string; name: string; currency: string; balance: string; createdAt: Date };

export type EntryView = {
  id: string;
  transferId: string;
  amount: string;
  currency: string;
  createdAt: Date;
  // The other side of the transfer. The system account has no id to show.
  counterparty: { accountId: string | null; name: string; kind: "USER" | "SYSTEM" };
};

export type EntryCursor = { createdAt: Date; id: string };

export function createWalletQueries(prisma: PrismaClient) {
  async function listAccounts(userId: string, accountId?: string): Promise<AccountView[]> {
    return prisma.$queryRaw<AccountView[]>`
      SELECT a."id", a."name", a."currency"::text AS "currency", a."createdAt",
             (SELECT COALESCE(sum(e."amount"), 0)::text FROM "ledger_entries" e WHERE e."accountId" = a."id") AS "balance"
        FROM "accounts" a
       WHERE a."userId" = ${userId}
         AND (${accountId ?? null}::text IS NULL OR a."id" = ${accountId ?? null})
       ORDER BY a."createdAt", a."id"`;
  }

  return {
    listAccounts: (userId: string) => listAccounts(userId),

    async findAccount(userId: string, accountId: string): Promise<AccountView | null> {
      const [account] = await listAccounts(userId, accountId);
      return account ?? null;
    },

    // Newest first. Null when the account is not the caller's.
    async listEntries(
      userId: string,
      accountId: string,
      page: { limit: number; after: EntryCursor | null },
    ): Promise<{ entries: EntryView[]; next: EntryCursor | null } | null> {
      const owned = await prisma.account.findFirst({ where: { id: accountId, userId }, select: { id: true } });
      if (!owned) {
        return null;
      }
      const rows = await prisma.$queryRaw<
        (Omit<EntryView, "counterparty"> & { otherAccountId: string; otherName: string; otherKind: "USER" | "SYSTEM" })[]
      >`
        SELECT e."id", e."transferId", e."amount"::text AS "amount", e."currency"::text AS "currency", e."createdAt",
               o."accountId" AS "otherAccountId", oa."name" AS "otherName", oa."kind"::text AS "otherKind"
          FROM "ledger_entries" e
          JOIN "ledger_entries" o ON o."transferId" = e."transferId" AND o."id" <> e."id"
          JOIN "accounts" oa ON oa."id" = o."accountId"
         WHERE e."accountId" = ${accountId}
           AND (${page.after?.createdAt ?? null}::timestamp IS NULL
                OR (e."createdAt", e."id") < (${page.after?.createdAt ?? null}::timestamp, ${page.after?.id ?? null}))
         ORDER BY e."createdAt" DESC, e."id" DESC
         LIMIT ${page.limit + 1}`;
      const pageRows = rows.slice(0, page.limit);
      const last = pageRows.at(-1);
      return {
        entries: pageRows.map(({ otherAccountId, otherName, otherKind, ...entry }) => ({
          ...entry,
          counterparty: { accountId: otherKind === "SYSTEM" ? null : otherAccountId, name: otherName, kind: otherKind },
        })),
        next: rows.length > page.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    },

    // Accounts of the caller's sandbox that belong to someone else. No balance: the caller
    // may pay them, not look into them.
    listRecipients(user: { id: string; sandboxId: string }) {
      return prisma.$queryRaw<{ accountId: string; accountName: string; currency: string; ownerName: string }[]>`
        SELECT a."id" AS "accountId", a."name" AS "accountName", a."currency"::text AS "currency",
               u."displayName" AS "ownerName"
          FROM "accounts" a
          JOIN "users" u ON u."id" = a."userId"
         WHERE a."sandboxId" = ${user.sandboxId} AND a."userId" <> ${user.id}
         ORDER BY u."displayName", a."createdAt", a."id"`;
    },

    // A transfer is visible to whoever owns one of the accounts it moved money through.
    async findTransfer(userId: string, transferId: string) {
      const transfer = await prisma.transfer.findFirst({
        where: { id: transferId, entries: { some: { account: { userId } } } },
        select: {
          id: true,
          status: true,
          createdAt: true,
          entries: { select: { accountId: true, amount: true, currency: true }, orderBy: { amount: "asc" } },
        },
      });
      return transfer;
    },

    listWebhookEvents(sandboxId: string, limit: number) {
      return prisma.$queryRaw<
        {
          id: string;
          type: string;
          transferId: string;
          status: "PENDING" | "DELIVERED" | "FAILED";
          attempts: number;
          nextAttemptAt: Date;
          lastError: string | null;
          deliveredAt: Date | null;
          createdAt: Date;
          receivedAt: Date | null;
          firstAttempt: number | null;
          deliveries: number | null;
        }[]
      >`
        SELECT o."id", o."type", o."transferId", o."status"::text AS "status", o."attempts", o."nextAttemptAt",
               o."lastError", o."deliveredAt", o."createdAt",
               r."receivedAt", r."firstAttempt", r."deliveries"
          FROM "outbox_events" o
          LEFT JOIN "webhook_receipts" r ON r."eventId" = o."id" AND r."sandboxId" = o."sandboxId"
         WHERE o."sandboxId" = ${sandboxId}
         ORDER BY o."createdAt" DESC, o."id" DESC
         LIMIT ${limit}`;
    },

    async setReceiverFailures(sandboxId: string, failures: number): Promise<void> {
      await prisma.sandbox.update({ where: { id: sandboxId }, data: { receiverFailuresLeft: failures } });
    },

    // Throws AccountLimitReached or UnsupportedCurrency.
    async openAccount(user: { id: string; sandboxId: string }, input: { name: string; currency: string }) {
      return prisma.$transaction(async (tx) => {
        // Serializes concurrent requests of the same user, so the limit cannot be raced past.
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;
        const issued = await tx.account.findMany({ where: { kind: "SYSTEM" }, select: { currency: true } });
        ensureCanOpenAccount({
          existingAccounts: await tx.account.count({ where: { userId: user.id } }),
          currency: input.currency,
          issuedCurrencies: issued.map((account) => account.currency),
        });
        const account = await tx.account.create({
          data: { userId: user.id, sandboxId: user.sandboxId, name: input.name, currency: input.currency },
          select: { id: true, name: true, currency: true, createdAt: true },
        });
        return { ...account, balance: "0" };
      });
    },
  };
}

export type WalletQueries = ReturnType<typeof createWalletQueries>;
