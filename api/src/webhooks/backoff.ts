export type RetryPolicy = {
  baseDelayMs: number;
  factor: number;
  // Total delivery attempts, the first one included. After the last failure the event is marked FAILED.
  maxAttempts: number;
};

// Waits of 1, 2, 4, 8 and 16 seconds between the six attempts: about half a minute in total,
// short enough to finish inside the request that woke the delivery process up.
export const defaultRetryPolicy: RetryPolicy = { baseDelayMs: 1000, factor: 2, maxAttempts: 6 };

// How long to wait after the given attempt (1-based) failed.
export function retryDelayMs(failedAttempt: number, policy: RetryPolicy): number {
  return policy.baseDelayMs * policy.factor ** (failedAttempt - 1);
}
