import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ClaimedEvent, OutboxStore } from "../../webhooks/dispatcher.js";

// The delivery side of the outbox. Every statement here fits the wallety_dispatch role:
// it reads events and updates delivery state, and touches nothing else.
export function createOutboxStore(prisma: PrismaClient): OutboxStore {
  return {
    async claimDue({ now, limit, leaseMs }) {
      const leaseUntil = new Date(now.getTime() + leaseMs);
      // One statement, so the claim is atomic. SKIP LOCKED lets several delivery processes
      // run side by side: each one takes different rows instead of waiting for the others.
      // Timestamps are passed as UTC text so the session time zone cannot shift them.
      return prisma.$queryRaw<ClaimedEvent[]>`
        UPDATE "outbox_events"
           SET "attempts" = "attempts" + 1,
               "nextAttemptAt" = ${leaseUntil.toISOString()}::timestamptz AT TIME ZONE 'UTC'
         WHERE "id" IN (
                 SELECT "id" FROM "outbox_events"
                  WHERE "status" = 'PENDING'
                    AND "nextAttemptAt" <= ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
                  ORDER BY "nextAttemptAt"
                  LIMIT ${limit}
                    FOR UPDATE SKIP LOCKED)
        RETURNING "id", "type", "payload", "attempts" AS "attempt"`;
    },

    async markDelivered(eventId, at) {
      await prisma.outboxEvent.update({
        where: { id: eventId },
        data: { status: "DELIVERED", deliveredAt: at, lastError: null },
      });
    },

    async scheduleRetry(eventId, nextAttemptAt, error) {
      await prisma.outboxEvent.update({
        where: { id: eventId },
        data: { nextAttemptAt, lastError: error },
      });
    },

    async markFailed(eventId, error) {
      await prisma.outboxEvent.update({
        where: { id: eventId },
        data: { status: "FAILED", lastError: error },
      });
    },

    async nextDueAt() {
      const next = await prisma.outboxEvent.findFirst({
        where: { status: "PENDING" },
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
      });
      return next?.nextAttemptAt ?? null;
    },
  };
}
