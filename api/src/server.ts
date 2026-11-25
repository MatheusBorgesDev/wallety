import { app } from "./app.js";
import { loadEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { createLogger } from "./observability/logger.js";

const env = loadEnv();
const logger = createLogger({ level: process.env.LOG_LEVEL ?? "info" });

// Bind to all interfaces: inside a container, localhost is not reachable from outside.
const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info({ port: env.port }, "API listening");
});

// Container platforms send SIGTERM before stopping an instance. Finish the
// requests in flight, release the database pool, then exit.
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
