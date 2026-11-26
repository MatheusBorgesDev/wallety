import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import type { WebhookSpec } from "../http/openapi.js";
import { defineRoute } from "../http/route.js";
import { verifySignature } from "../webhooks/signature.js";

type ReceiverOptions = {
  prisma: PrismaClient;
  signingSecret: string;
  now?: () => Date;
};

export const transferPostedEventSchema = z
  .object({
    id: z.uuid().describe("Event id. The same in every delivery attempt: use it to deduplicate"),
    type: z.literal("transfer.posted"),
    createdAt: z.iso.datetime(),
    data: z.object({
      transferId: z.uuid(),
      sandboxId: z.uuid(),
      entries: z.array(
        z.object({
          accountId: z.uuid(),
          amount: z.string().describe("Signed integer in minor units: negative is a debit, positive is a credit"),
          currency: z.string().length(3),
        }),
      ),
    }),
  })
  .meta({ id: "TransferPostedEvent" });

export const deliveryHeadersSchema = z.object({
  "wallety-event-id": z.string().describe("The event id, the same in every attempt"),
  "wallety-event-type": z.string(),
  "wallety-delivery-attempt": z.string().describe("Attempt number, starting at 1"),
  "wallety-signature": z
    .string()
    .describe("`t=<unix seconds>,v1=<hex>`: HMAC-SHA256, with the signing secret, of `<t>.<raw body>`"),
});

export const transferPostedWebhook: WebhookSpec = {
  name: "transfer.posted",
  summary: "A transfer was posted to the ledger",
  description:
    "Written in the same database transaction as the ledger entries and delivered afterwards by a separate " +
    "process, at least once: a receiver must deduplicate on the event id. Order between events is not guaranteed.",
  headers: deliveryHeadersSchema,
  body: transferPostedEventSchema,
};

// What the receiver needs from an event. It reads nothing else.
const receivedEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ sandboxId: z.string() }),
});

function parseEvent(raw: string): z.infer<typeof receivedEventSchema> | null {
  try {
    const result = receivedEventSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// The built-in receiver: what a consumer of these webhooks is expected to do. It checks the
// signature against the raw bytes, refuses old deliveries, and deduplicates on the event id,
// because delivery is at least once. It trusts nothing but the signature.
export function webhookReceiverRoute(options: ReceiverOptions) {
  const { prisma, signingSecret } = options;
  const now = options.now ?? (() => new Date());

  return defineRoute({
    method: "post",
    path: "/webhooks/receiver",
    tag: "Webhooks",
    summary: "Built-in webhook receiver",
    description:
      "Where this deployment delivers its own events. It has no login: it accepts only a delivery whose " +
      "signature is valid and recent.",
    access: "public",
    // The signature covers the exact bytes sent, so the body must not be parsed before it is verified.
    rawBody: true,
    request: { headers: deliveryHeadersSchema.partial(), body: transferPostedEventSchema },
    responses: {
      200: {
        description: "The event was recorded, or had already been",
        schema: z.object({ received: z.literal(true), duplicate: z.boolean() }),
      },
      401: { description: "The signature is missing, invalid or too old" },
      503: { description: "Simulated failure, requested through the receiver failure control" },
    },
    handler: async ({ headers, rawBody }) => {
      const body = rawBody?.toString("utf8") ?? "";
      const check = verifySignature({
        secret: signingSecret,
        header: headers["wallety-signature"],
        body,
        nowSeconds: Math.floor(now().getTime() / 1000),
      });
      if (!check.valid) {
        throw new HttpError(401, "invalid_signature", "Invalid signature");
      }

      const event = parseEvent(body);
      if (!event) {
        throw new HttpError(400, "invalid_event", "Invalid event");
      }

      // Failure simulation: refuse this delivery if the sandbox still has failures to spend.
      // The decrement and the check are one statement, so concurrent deliveries cannot overspend it.
      const refused = await prisma.$executeRaw`
        UPDATE "sandboxes" SET "receiverFailuresLeft" = "receiverFailuresLeft" - 1
         WHERE "id" = ${event.data.sandboxId} AND "receiverFailuresLeft" > 0`;
      if (refused === 1) {
        throw new HttpError(503, "simulated_failure", "Simulated receiver failure");
      }

      const attempt = Number(headers["wallety-delivery-attempt"]) || 1;
      const receipt = await prisma.webhookReceipt.upsert({
        where: { eventId: event.id },
        create: { eventId: event.id, sandboxId: event.data.sandboxId, type: event.type, firstAttempt: attempt },
        update: { deliveries: { increment: 1 } },
      });
      return { status: 200, body: { received: true, duplicate: receipt.deliveries > 1 } };
    },
  });
}
