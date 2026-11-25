import { Router } from "express";
import { prisma } from "../db/prisma.js";

export const healthRouter = Router();

// Liveness: answers without touching the database, so frequent uptime checks
// do not keep a scale-to-zero database awake.
healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: proves the API can reach the database.
healthRouter.get("/", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "ok" });
  } catch {
    res.status(503).json({ status: "error", db: "down" });
  }
});
