import express, { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { verifySignature } from "../webhooks/signature.js";

type ReceiverOptions = {
  prisma: PrismaClient;
  signingSecret: string;
  now?: () => Date;
};

type EventBody = {
  id: string;
  type: string;
  data: { sandboxId: string };
};

function parseEvent(raw: string): EventBody | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const event = parsed as Partial<EventBody>;
    if (
      typeof event?.id === "string" &&
      typeof event.type === "string" &&
      typeof event.data?.sandboxId === "string"
    ) {
      return event as EventBody;
    }
  } catch {
    // Not JSON: fall through.
  }
  return null;
}

// The built-in receiver: what a consumer of these webhooks is expected to do. It checks the
// signature against the raw bytes, refuses old deliveries, and deduplicates on the event id,
// because delivery is at least once. It trusts nothing but the signature.
export function createWebhookReceiverRouter(options: ReceiverOptions): Router {
  const { prisma, signingSecret } = options;
  const now = options.now ?? (() => new Date());
  const router = Router();

  // The signature covers the exact bytes sent, so the body must not be parsed before it is verified.
  router.post("/", express.raw({ type: "*/*", limit: "64kb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const check = verifySignature({
      secret: signingSecret,
      header: req.get("Wallety-Signature"),
      body: rawBody,
      nowSeconds: Math.floor(now().getTime() / 1000),
    });
    if (!check.valid) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = parseEvent(rawBody);
    if (!event) {
      res.status(400).json({ error: "Invalid event" });
      return;
    }

    // Failure simulation: refuse this delivery if the sandbox still has failures to spend.
    // The decrement and the check are one statement, so concurrent deliveries cannot overspend it.
    const refused = await prisma.$executeRaw`
      UPDATE "sandboxes" SET "receiverFailuresLeft" = "receiverFailuresLeft" - 1
       WHERE "id" = ${event.data.sandboxId} AND "receiverFailuresLeft" > 0`;
    if (refused === 1) {
      res.status(503).json({ error: "Simulated receiver failure" });
      return;
    }

    const attempt = Number(req.get("Wallety-Delivery-Attempt")) || 1;
    const receipt = await prisma.webhookReceipt.upsert({
      where: { eventId: event.id },
      create: { eventId: event.id, sandboxId: event.data.sandboxId, type: event.type, firstAttempt: attempt },
      update: { deliveries: { increment: 1 } },
    });
    res.json({ received: true, duplicate: receipt.deliveries > 1 });
  });

  return router;
}
