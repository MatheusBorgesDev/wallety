import express from "express";
import { healthRouter } from "./routes/health.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";
import { createHttpLogger } from "./observability/http-logger.js";
import { createLogger, type Logger } from "./observability/logger.js";

type AppOptions = {
  logger?: Logger;
};

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? defaultLogger();
  const app = express();
  app.use(createHttpLogger(logger));
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
