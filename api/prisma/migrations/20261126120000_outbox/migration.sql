-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "receiverFailuresLeft" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_receipts" (
    "eventId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "firstAttempt" INTEGER NOT NULL,
    "deliveries" INTEGER NOT NULL DEFAULT 1,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_receipts_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_transferId_key" ON "outbox_events"("transferId");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextAttemptAt_idx" ON "outbox_events"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "outbox_events_sandboxId_createdAt_idx" ON "outbox_events"("sandboxId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_receipts_sandboxId_idx" ON "webhook_receipts"("sandboxId");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Everything below is written by hand: guarantees Prisma cannot express.
-- ---------------------------------------------------------------------------

-- An event exists if and only if its transfer exists. The foreign key covers one direction
-- (no event without a transfer). These deferred triggers cover the other one: when a
-- transaction commits, every transfer it created must have its outbox event, and no event
-- may have been removed while its transfer stays.
CREATE FUNCTION assert_transfer_has_event(target_transfer_id TEXT) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "transfers" WHERE "id" = target_transfer_id)
     AND NOT EXISTS (SELECT 1 FROM "outbox_events" WHERE "transferId" = target_transfer_id) THEN
    RAISE EXCEPTION 'transfer % has no outbox event', target_transfer_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION transfers_event_trigger() RETURNS trigger AS $$
BEGIN
  PERFORM assert_transfer_has_event(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "transfers_have_event"
  AFTER INSERT ON "transfers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transfers_event_trigger();

CREATE FUNCTION outbox_events_removed_trigger() RETURNS trigger AS $$
BEGIN
  PERFORM assert_transfer_has_event(OLD."transferId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "outbox_events_kept_with_transfer"
  AFTER DELETE OR UPDATE OF "transferId" ON "outbox_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION outbox_events_removed_trigger();

-- Privileges.
--   wallety_app      writes events with the transfer and runs the built-in receiver.
--   wallety_dispatch the delivery process: reads events and updates delivery state only.
--                    It cannot read or write the ledger, nor change what an event says.
--   wallety_purge    removes events and receipts together with their sandbox.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_dispatch') THEN
    CREATE ROLE wallety_dispatch NOLOGIN;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO wallety_dispatch;
GRANT SELECT, INSERT ON "outbox_events" TO wallety_app;
GRANT SELECT, INSERT, UPDATE ON "webhook_receipts" TO wallety_app;
GRANT SELECT ON "outbox_events" TO wallety_dispatch;
GRANT UPDATE ("status", "attempts", "nextAttemptAt", "lastError", "deliveredAt") ON "outbox_events" TO wallety_dispatch;
GRANT SELECT, DELETE ON "outbox_events", "webhook_receipts" TO wallety_purge;
