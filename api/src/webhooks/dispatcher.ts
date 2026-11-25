import { defaultRetryPolicy, retryDelayMs, type RetryPolicy } from "./backoff.js";
import { signPayload } from "./signature.js";

// An event taken from the outbox for one delivery attempt. `attempt` already counts this one.
export type ClaimedEvent = {
  id: string;
  type: string;
  payload: string;
  attempt: number;
};

export type OutboxStore = {
  // Takes due events and, in the same statement, pushes their next attempt forward by the
  // lease. If this process dies after sending, the lease expires and the event is delivered
  // again: delivery is at least once, which is why the event id never changes.
  claimDue(input: { now: Date; limit: number; leaseMs: number }): Promise<ClaimedEvent[]>;
  markDelivered(eventId: string, at: Date): Promise<void>;
  scheduleRetry(eventId: string, nextAttemptAt: Date, error: string): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
  // When the earliest pending event becomes due, or null when nothing is pending.
  nextDueAt(): Promise<Date | null>;
};

export type DeliveryRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type DeliveryOutcome = { ok: true } | { ok: false; error: string };

export type Transport = {
  send(request: DeliveryRequest): Promise<DeliveryOutcome>;
};

export type DispatcherLog = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

export type DispatcherDeps = {
  store: OutboxStore;
  transport: Transport;
  targetUrl: string;
  signingSecret: string;
  now: () => Date;
  log?: DispatcherLog;
  policy?: RetryPolicy;
  batchSize?: number;
  leaseMs?: number;
};

export type DispatchSummary = { delivered: number; retried: number; failed: number };

const DEFAULT_BATCH_SIZE = 20;
// Longer than the transport timeout, so an attempt in flight is never claimed twice.
const DEFAULT_LEASE_MS = 30_000;

export function buildDeliveryRequest(
  event: ClaimedEvent,
  targetUrl: string,
  signingSecret: string,
  now: Date,
): DeliveryRequest {
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  return {
    url: targetUrl,
    headers: {
      "Content-Type": "application/json",
      "Wallety-Event-Id": event.id,
      "Wallety-Event-Type": event.type,
      "Wallety-Delivery-Attempt": String(event.attempt),
      "Wallety-Signature": signPayload(signingSecret, timestampSeconds, event.payload),
    },
    body: event.payload,
  };
}

// One pass over the outbox: deliver everything that is due and record each outcome.
// No database transaction is open while a request is in flight.
export async function dispatchDue(deps: DispatcherDeps): Promise<DispatchSummary> {
  const policy = deps.policy ?? defaultRetryPolicy;
  const summary: DispatchSummary = { delivered: 0, retried: 0, failed: 0 };

  const events = await deps.store.claimDue({
    now: deps.now(),
    limit: deps.batchSize ?? DEFAULT_BATCH_SIZE,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
  });

  for (const event of events) {
    const request = buildDeliveryRequest(event, deps.targetUrl, deps.signingSecret, deps.now());
    const startedAt = Date.now();
    const outcome = await deps.transport.send(request);
    const fields = { eventId: event.id, attempt: event.attempt, durationMs: Date.now() - startedAt };

    if (outcome.ok) {
      await deps.store.markDelivered(event.id, deps.now());
      summary.delivered += 1;
      deps.log?.info(fields, "webhook delivered");
    } else if (event.attempt >= policy.maxAttempts) {
      await deps.store.markFailed(event.id, outcome.error);
      summary.failed += 1;
      deps.log?.warn({ ...fields, error: outcome.error }, "webhook failed permanently");
    } else {
      const nextAttemptAt = new Date(deps.now().getTime() + retryDelayMs(event.attempt, policy));
      await deps.store.scheduleRetry(event.id, nextAttemptAt, outcome.error);
      summary.retried += 1;
      deps.log?.warn({ ...fields, error: outcome.error, nextAttemptAt }, "webhook attempt failed");
    }
  }

  return summary;
}

// Keeps dispatching until nothing is pending or the time budget runs out, sleeping
// until the next retry is due. This is what one wake-up of the delivery process runs.
export async function drain(
  deps: DispatcherDeps,
  options: { maxDurationMs: number; sleep: (ms: number) => Promise<void> },
): Promise<DispatchSummary> {
  const deadline = deps.now().getTime() + options.maxDurationMs;
  const total: DispatchSummary = { delivered: 0, retried: 0, failed: 0 };

  for (;;) {
    const pass = await dispatchDue(deps);
    total.delivered += pass.delivered;
    total.retried += pass.retried;
    total.failed += pass.failed;

    const nextDueAt = await deps.store.nextDueAt();
    if (!nextDueAt) {
      return total;
    }
    const waitMs = nextDueAt.getTime() - deps.now().getTime();
    if (deps.now().getTime() + waitMs > deadline) {
      return total;
    }
    if (waitMs > 0) {
      await options.sleep(waitMs);
    }
  }
}
