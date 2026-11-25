-- CreateEnum
CREATE TYPE "SandboxKind" AS ENUM ('DEMO', 'REGISTERED');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('POSTED');

-- DropIndex
DROP INDEX "ledger_entries_accountId_idx";

-- DropIndex
DROP INDEX "transfers_idempotencyKey_key";

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "kind" "AccountKind" NOT NULL DEFAULT 'USER',
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "sandboxId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "currency" SET DATA TYPE CHAR(3);

-- AlterTable
ALTER TABLE "ledger_entries" ALTER COLUMN "currency" SET DATA TYPE CHAR(3);

-- AlterTable
ALTER TABLE "transfers" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "idempotencyScope" TEXT NOT NULL,
ADD COLUMN     "requestHash" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "TransferStatus" NOT NULL DEFAULT 'POSTED';

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" TEXT NOT NULL,
    "kind" "SandboxKind" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "displayName" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_sandboxId_idx" ON "users"("sandboxId");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE INDEX "accounts_sandboxId_idx" ON "accounts"("sandboxId");

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_createdAt_id_idx" ON "ledger_entries"("accountId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_transferId_idx" ON "ledger_entries"("transferId");

-- CreateIndex
CREATE INDEX "transfers_createdByUserId_idx" ON "transfers"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_idempotencyScope_idempotencyKey_key" ON "transfers"("idempotencyScope", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Everything below is written by hand: guarantees Prisma cannot express.
-- ---------------------------------------------------------------------------

-- An entry always moves money.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("amount" <> 0);

-- ISO 4217 style codes.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

-- A SYSTEM account belongs to no one; a USER account always has an owner and a sandbox.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_kind_ownership" CHECK (
  ("kind" = 'SYSTEM' AND "userId" IS NULL AND "sandboxId" IS NULL)
  OR ("kind" = 'USER' AND "userId" IS NOT NULL AND "sandboxId" IS NOT NULL)
);

-- Exactly one SYSTEM account per currency.
CREATE UNIQUE INDEX "accounts_one_system_per_currency" ON "accounts"("currency") WHERE "kind" = 'SYSTEM';

-- An entry is always in the currency of its account.
CREATE FUNCTION ledger_entry_matches_account_currency() RETURNS trigger AS $$
DECLARE
  account_currency CHAR(3);
BEGIN
  SELECT "currency" INTO account_currency FROM "accounts" WHERE "id" = NEW."accountId";
  IF account_currency IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'ledger entry currency % does not match account currency %', NEW."currency", account_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_account_currency"
  BEFORE INSERT OR UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_matches_account_currency();

-- Double entry, enforced by the database: when a transaction commits, every transfer it
-- touched must have at least two entries, in one currency, summing to zero. The check is
-- deferred to commit time so the entries of a transfer can be inserted one by one.
-- A transfer whose entries were all removed (a whole-sandbox purge) is left alone.
CREATE FUNCTION assert_transfer_is_balanced(target_transfer_id TEXT) RETURNS void AS $$
DECLARE
  entry_count INTEGER;
  currency_count INTEGER;
  total NUMERIC;
  transfer_exists BOOLEAN;
BEGIN
  SELECT count(*), count(DISTINCT "currency"), COALESCE(sum("amount"), 0)
    INTO entry_count, currency_count, total
    FROM "ledger_entries" WHERE "transferId" = target_transfer_id;
  SELECT EXISTS (SELECT 1 FROM "transfers" WHERE "id" = target_transfer_id) INTO transfer_exists;

  IF entry_count = 0 AND NOT transfer_exists THEN
    RETURN;
  END IF;
  IF entry_count < 2 OR currency_count <> 1 OR total <> 0 THEN
    RAISE EXCEPTION 'transfer % is not balanced: % entries, % currencies, sum %',
      target_transfer_id, entry_count, currency_count, total
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION ledger_entries_balanced_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM assert_transfer_is_balanced(OLD."transferId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM assert_transfer_is_balanced(NEW."transferId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT OR UPDATE OR DELETE ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_balanced_trigger();

-- A transfer cannot be committed without its entries.
CREATE FUNCTION transfers_balanced_trigger() RETURNS trigger AS $$
BEGIN
  PERFORM assert_transfer_is_balanced(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "transfers_balanced"
  AFTER INSERT ON "transfers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transfers_balanced_trigger();

-- Money enters the ledger only through the SYSTEM account of each currency.
INSERT INTO "accounts" ("id", "kind", "name", "currency") VALUES
  (gen_random_uuid()::text, 'SYSTEM', 'System BRL', 'BRL'),
  (gen_random_uuid()::text, 'SYSTEM', 'System USD', 'USD');

-- Privileges. Two group roles, never used to log in:
--   wallety_app   what the API may do. The ledger is append-only for it: no UPDATE and
--                 no DELETE on transfers and ledger entries, and no DELETE anywhere.
--   wallety_purge what the cleanup job may do: read and delete, nothing else.
-- Each environment creates its own login roles and makes them members of these.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_app') THEN
    CREATE ROLE wallety_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_purge') THEN
    CREATE ROLE wallety_purge NOLOGIN;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO wallety_app, wallety_purge;
GRANT SELECT, INSERT, UPDATE ON "sandboxes", "users", "accounts" TO wallety_app;
GRANT SELECT, INSERT ON "transfers", "ledger_entries" TO wallety_app;
GRANT SELECT, DELETE ON "sandboxes", "users", "accounts", "transfers", "ledger_entries" TO wallety_purge;
