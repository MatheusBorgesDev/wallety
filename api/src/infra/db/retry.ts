import { setTimeout as sleepFor } from "node:timers/promises";

// PostgreSQL aborts one of the transactions involved and expects the client to run it again.
export const SERIALIZATION_FAILURE = "40001";
export const DEADLOCK_DETECTED = "40P01";

export type RetryPolicy = {
  // Total number of times the work may run, the first one included.
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type RetryHooks = {
  // Called once per retry, with the PostgreSQL error code that caused it.
  onRetry?: (sqlState: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
};

// The PostgreSQL error code carried by an error thrown by Prisma, wherever Prisma put it.
export function sqlStateOf(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null || depth > 4) {
    return undefined;
  }
  const candidate = error as { originalCode?: unknown; meta?: unknown; cause?: unknown; driverAdapterError?: unknown };
  if (typeof candidate.originalCode === "string") {
    return candidate.originalCode;
  }
  return (
    sqlStateOf(candidate.meta, depth + 1) ??
    sqlStateOf(candidate.driverAdapterError, depth + 1) ??
    sqlStateOf(candidate.cause, depth + 1)
  );
}

// The longest a retry may wait: doubles on every retry up to maxDelayMs.
export function retryDelayCeilingMs(policy: RetryPolicy, retry: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
}

// Runs the work again when the database aborted it because of a concurrent transaction.
// The wait before each retry is random under a growing ceiling, so transactions that
// collided once do not collide again in lockstep.
export async function retryOnConflict<T>(
  work: () => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<T> {
  const { onRetry, sleep = sleepFor, random = Math.random } = hooks;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const sqlState = sqlStateOf(error);
      const retryable = sqlState === SERIALIZATION_FAILURE || sqlState === DEADLOCK_DETECTED;
      if (!retryable || attempt >= policy.maxAttempts) {
        throw error;
      }
      onRetry?.(sqlState);
      await sleep(random() * retryDelayCeilingMs(policy, attempt));
    }
  }
}
