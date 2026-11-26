import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import { defineRoute, type AnyRoute } from "../http/route.js";

export function healthRoutes(prisma: PrismaClient): AnyRoute[] {
  return [
    // Liveness: answers without touching the database, so frequent uptime checks
    // do not keep a scale-to-zero database awake.
    defineRoute({
      method: "get",
      path: "/health/live",
      tag: "Health",
      summary: "Liveness: the process is up",
      description: "Does not touch the database.",
      access: "public",
      responses: { 200: { description: "The process is up", schema: z.object({ status: z.literal("ok") }) } },
      handler: async () => ({ status: 200, body: { status: "ok" } }),
    }),
    // Readiness: proves the API can reach the database.
    defineRoute({
      method: "get",
      path: "/health",
      tag: "Health",
      summary: "Readiness: the API can reach the database",
      access: "public",
      responses: {
        200: { description: "Ready", schema: z.object({ status: z.literal("ok"), db: z.literal("ok") }) },
        503: {
          description: "The database is unreachable",
          schema: z.object({ status: z.literal("error"), db: z.literal("down") }),
        },
      },
      handler: async () => {
        try {
          await prisma.$queryRaw`SELECT 1`;
          return { status: 200, body: { status: "ok", db: "ok" } };
        } catch {
          return { status: 503, body: { status: "error", db: "down" } };
        }
      },
    }),
  ];
}
