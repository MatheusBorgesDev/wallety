import express from "express";
import { notFoundHandler, errorHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  // routes go here (health in Task 4)
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
