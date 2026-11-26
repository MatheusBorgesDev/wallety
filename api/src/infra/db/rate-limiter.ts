import type { PrismaClient } from "../../generated/prisma/client.js";
import type { RateLimitRule } from "../../http/route.js";

// The fixed window a moment falls into, and how long until the next one starts.
export function windowAt(now: Date, windowSeconds: number): { start: Date; secondsLeft: number } {
  const windowMs = windowSeconds * 1000;
  const startMs = Math.floor(now.getTime() / windowMs) * windowMs;
  return { start: new Date(startMs), secondsLeft: Math.max(1, Math.ceil((startMs + windowMs - now.getTime()) / 1000)) };
}

// Counts one request against a rule. Returns null while the request is within the limit,
// or the seconds to wait once it is not. The counter lives in PostgreSQL, so the limit
// holds across instances and restarts; one upsert both counts and reads.
export function createRateLimiter(prisma: PrismaClient, now: () => Date = () => new Date()) {
  return async function hitRateLimit(rule: RateLimitRule): Promise<number | null> {
    const window = windowAt(now(), rule.windowSeconds);
    const [row] = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "rate_limit_hits" ("key", "windowStart", "count")
      VALUES (${rule.key}, ${window.start}, 1)
      ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "rate_limit_hits"."count" + 1
      RETURNING "count"`;
    return row!.count > rule.limit ? window.secondsLeft : null;
  };
}
