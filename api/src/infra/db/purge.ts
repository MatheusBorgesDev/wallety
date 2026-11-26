import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

// How long after expiry a sandbox is left alone, so a request that was authenticated just
// before the deadline has finished by the time its rows are removed.
export const PURGE_GRACE_MS = 60_000;
// A registered user that has not signed in for this long is removed with its sandbox.
export const REGISTERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Rate-limit windows older than this can no longer affect any limit.
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

export type PurgeSummary = { sandboxes: number; rateLimitWindows: number };

export type Purger = {
  purge(options: { now: Date; maxSandboxes: number }): Promise<PurgeSummary>;
  disconnect(): Promise<void>;
};

// Physical removal of what has expired. It runs on its own database login, the only one
// allowed to delete: the login the API serves requests with can neither delete a row nor
// change a ledger entry.
//
// A sandbox goes as a whole, in one transaction: users only transact inside their own
// sandbox, so removing all of it takes both sides of every transfer, the system account's
// side of the opening balance included, and the ledger still sums to zero afterwards. The
// database enforces that: a transaction that removed only one side would not commit.
export function createPurger(databaseUrl: string): Purger {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 2 }) });

  async function dueSandboxes(now: Date, limit: number): Promise<string[]> {
    const expiredBefore = new Date(now.getTime() - PURGE_GRACE_MS);
    const activeSince = new Date(now.getTime() - REGISTERED_RETENTION_MS);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s."id"
        FROM "sandboxes" s
       WHERE s."expiresAt" < ${expiredBefore}
          OR (s."kind" = 'REGISTERED'
              AND NOT EXISTS (
                SELECT 1 FROM "users" u
                 WHERE u."sandboxId" = s."id"
                   AND u."email" IS NOT NULL
                   AND COALESCE(u."lastLoginAt", u."createdAt") >= ${activeSince}))
       ORDER BY s."createdAt"
       LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async function removeSandbox(sandboxId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const transfers = await tx.$queryRaw<{ transferId: string }[]>`
        SELECT DISTINCT e."transferId"
          FROM "ledger_entries" e
          JOIN "accounts" a ON a."id" = e."accountId"
         WHERE a."sandboxId" = ${sandboxId}`;
      const transferIds = transfers.map((row) => row.transferId);

      await tx.$executeRaw`DELETE FROM "webhook_receipts" WHERE "sandboxId" = ${sandboxId}`;
      await tx.$executeRaw`DELETE FROM "outbox_events" WHERE "sandboxId" = ${sandboxId}`;
      await tx.$executeRaw`DELETE FROM "ledger_entries" WHERE "transferId" = ANY(${transferIds})`;
      await tx.$executeRaw`DELETE FROM "transfers" WHERE "id" = ANY(${transferIds})`;
      await tx.$executeRaw`DELETE FROM "accounts" WHERE "sandboxId" = ${sandboxId}`;
      await tx.$executeRaw`DELETE FROM "users" WHERE "sandboxId" = ${sandboxId}`;
      await tx.$executeRaw`DELETE FROM "sandboxes" WHERE "id" = ${sandboxId}`;
    });
  }

  return {
    async purge({ now, maxSandboxes }) {
      let sandboxes = 0;
      for (const sandboxId of await dueSandboxes(now, maxSandboxes)) {
        await removeSandbox(sandboxId);
        sandboxes += 1;
      }
      const rateLimitWindows = await prisma.$executeRaw`
        DELETE FROM "rate_limit_hits" WHERE "windowStart" < ${new Date(now.getTime() - RATE_LIMIT_RETENTION_MS)}`;
      return { sandboxes, rateLimitWindows };
    },
    disconnect: () => prisma.$disconnect(),
  };
}
