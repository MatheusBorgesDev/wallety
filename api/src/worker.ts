import express from "express";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { createOutboxStore } from "./infra/db/outbox-store.js";
import { createHttpTransport } from "./infra/webhooks/http-transport.js";
import { createLogger } from "./observability/logger.js";
import { dispatchDue, drain, type DispatcherDeps } from "./webhooks/dispatcher.js";

// The delivery process. It shares the image with the API and nothing else: it has its own
// entry point, its own database login (outbox only) and no route that touches the ledger.
//
// It works in two ways, and both can be on at once:
//   - POST /internal/dispatch drains the outbox inside the request. This is how it runs on a
//     platform that only gives CPU while a request is in flight: something wakes it up.
//   - WORKER_POLL_INTERVAL_MS makes it look for due events on a timer, for an always-on container.
const env = loadEnv();
const targetUrl = process.env.WEBHOOK_TARGET_URL;
if (!targetUrl) {
  throw new Error("Missing required env var: WEBHOOK_TARGET_URL");
}
const pollIntervalMs = process.env.WORKER_POLL_INTERVAL_MS ? Number(process.env.WORKER_POLL_INTERVAL_MS) : null;
if (pollIntervalMs !== null && !(pollIntervalMs > 0)) {
  throw new Error(`Invalid WORKER_POLL_INTERVAL_MS: ${process.env.WORKER_POLL_INTERVAL_MS}`);
}

const logger = createLogger({ level: process.env.LOG_LEVEL ?? "info" });
const deps: DispatcherDeps = {
  store: createOutboxStore(prisma),
  transport: createHttpTransport(),
  targetUrl,
  signingSecret: env.webhookSigningSecret,
  now: () => new Date(),
  log: logger,
};

// One pass at a time: a second trigger while one is running would only compete for the same rows.
let busy = false;
async function runExclusive<T>(work: () => Promise<T>): Promise<T | null> {
  if (busy) {
    return null;
  }
  busy = true;
  try {
    return await work();
  } finally {
    busy = false;
  }
}

const app = express();
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});
app.post("/internal/dispatch", async (_req, res) => {
  const summary = await runExclusive(() => drain(deps, { maxDurationMs: 60_000, sleep: (ms) => sleep(ms) }));
  if (summary === null) {
    res.status(202).json({ status: "already running" });
    return;
  }
  res.json({ status: "done", ...summary });
});

const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info({ port: env.port, pollIntervalMs }, "Delivery process listening");
});

const timer =
  pollIntervalMs === null
    ? null
    : setInterval(() => {
        runExclusive(() => dispatchDue(deps)).catch((error: unknown) => {
          logger.error({ err: error }, "Dispatch pass failed");
        });
      }, pollIntervalMs);

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  if (timer) {
    clearInterval(timer);
  }
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
