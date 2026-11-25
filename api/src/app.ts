import express from "express";
import { loadEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { healthRouter } from "./routes/health.js";
import { createWebhookReceiverRouter } from "./routes/webhook-receiver.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";
import { createHttpLogger } from "./observability/http-logger.js";
import { createLogger, type Logger } from "./observability/logger.js";

type AppOptions = {
  logger?: Logger;
  webhookSigningSecret?: string;
};

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? defaultLogger();
  const webhookSigningSecret = options.webhookSigningSecret ?? loadEnv().webhookSigningSecret;
  const app = express();
  app.use(createHttpLogger(logger));
  // Mounted before the JSON parser: the receiver verifies a signature over the raw body.
  app.use("/webhooks/receiver", createWebhookReceiverRouter({ prisma, signingSecret: webhookSigningSecret }));
  app.use(express.json());
  app.use("/health", healthRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function defaultLogger(): Logger {
  const level =
    process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");
  return createLogger({ level });
}

export const app = createApp();
