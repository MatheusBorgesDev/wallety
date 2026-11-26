-- Fixed-window counters for rate limiting.
CREATE TABLE "rate_limit_hits" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY ("key","windowStart")
);

CREATE INDEX "rate_limit_hits_windowStart_idx" ON "rate_limit_hits"("windowStart");

-- Privileges: the API counts, the cleanup removes old windows.
GRANT SELECT, INSERT, UPDATE ON "rate_limit_hits" TO wallety_app;
GRANT SELECT, DELETE ON "rate_limit_hits" TO wallety_purge;
