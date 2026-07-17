import express from "express";
import { healthRouter } from "./routes/health.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/health", healthRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
