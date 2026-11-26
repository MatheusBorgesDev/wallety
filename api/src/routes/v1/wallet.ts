import { z } from "zod";
import type { Ledger } from "../../application/ledger.js";
import { transferMoney } from "../../application/transfer-money.js";
import { AccountLimitReached, UnsupportedCurrency } from "../../domain/errors.js";
import { MAX_ACCOUNTS_PER_USER } from "../../domain/opening.js";
import type { EntryCursor, WalletQueries } from "../../infra/db/wallet-queries.js";
import type { DispatchNotifier } from "../../infra/webhooks/dispatch-notifier.js";
import { HttpError } from "../../http/errors.js";
import { defineRoute, type AnyRoute } from "../../http/route.js";

type WalletDependencies = {
  queries: WalletQueries;
  ledger: Ledger;
  // Absent where the delivery process finds events on its own.
  notifyDispatcher?: DispatchNotifier;
};

const money = z
  .string()
  .regex(/^-?\d+$/)
  .describe("Integer in minor units (cents), as a string: JSON numbers lose precision beyond 2^53");

const currency = z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217 code");

const accountSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    currency,
    balance: money.describe("Derived from the ledger entries of the account; never stored"),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "Account" });

const entrySchema = z
  .object({
    id: z.uuid(),
    transferId: z.uuid(),
    amount: money.describe("Signed: negative is a debit, positive is a credit"),
    currency,
    createdAt: z.iso.datetime(),
    counterparty: z.object({
      accountId: z.uuid().nullable().describe("Null when the other side is the system account"),
      name: z.string(),
      kind: z.enum(["USER", "SYSTEM"]),
    }),
  })
  .meta({ id: "LedgerEntry" });

const transferSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(["POSTED"]),
    createdAt: z.iso.datetime(),
    entries: z
      .array(z.object({ accountId: z.uuid(), amount: money, currency }))
      .describe("Always sums to zero: one debit and one credit"),
  })
  .meta({ id: "Transfer" });

const webhookEventSchema = z
  .object({
    id: z.uuid().describe("The id the receiver deduplicates on"),
    type: z.string(),
    transferId: z.uuid(),
    status: z.enum(["PENDING", "DELIVERED", "FAILED"]),
    attempts: z.number().int(),
    nextAttemptAt: z.iso.datetime().nullable().describe("Null once the event is delivered or has failed for good"),
    lastError: z.string().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    receipt: z
      .object({
        receivedAt: z.iso.datetime(),
        firstAttempt: z.number().int().describe("The attempt number the receiver accepted"),
        deliveries: z.number().int().describe("Greater than 1 when the same event arrived again"),
      })
      .nullable()
      .describe("What the built-in receiver recorded, if it accepted the event"),
  })
  .meta({ id: "WebhookEvent" });

const idParam = z.object({ id: z.uuid() });

const notFound = (what: string) => new HttpError(404, `${what}_not_found`, `${what[0]!.toUpperCase()}${what.slice(1)} not found`);

function encodeCursor(cursor: EntryCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString("base64url");
}

function decodeCursor(value: string): EntryCursor {
  try {
    const [createdAt, id] = z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { createdAt: new Date(createdAt), id };
  } catch {
    throw new HttpError(400, "invalid_cursor", "The cursor is not valid");
  }
}

type AccountRow = Awaited<ReturnType<WalletQueries["listAccounts"]>>[number];
const accountView = (account: AccountRow) => ({ ...account, createdAt: account.createdAt.toISOString() });

type TransferRow = NonNullable<Awaited<ReturnType<WalletQueries["findTransfer"]>>>;
const transferView = (transfer: TransferRow) => ({
  id: transfer.id,
  status: transfer.status,
  createdAt: transfer.createdAt.toISOString(),
  entries: transfer.entries.map((entry) => ({ ...entry, amount: entry.amount.toString() })),
});

export function walletRoutes(deps: WalletDependencies): AnyRoute[] {
  const { queries } = deps;

  return [
    defineRoute({
      method: "get",
      path: "/v1/accounts",
      tag: "Accounts",
      summary: "My accounts, with their balances",
      access: "user",
      responses: { 200: { description: "The caller's accounts", schema: z.object({ accounts: z.array(accountSchema) }) } },
      handler: async ({ user }) => ({
        status: 200,
        body: { accounts: (await queries.listAccounts(user.id)).map(accountView) },
      }),
    }),

    defineRoute({
      method: "post",
      path: "/v1/accounts",
      tag: "Accounts",
      summary: "Open an account",
      description: `The account starts empty: money only enters it through a transfer. At most ${MAX_ACCOUNTS_PER_USER} accounts per user.`,
      access: "user",
      request: { body: z.object({ name: z.string().trim().min(1).max(60), currency }) },
      responses: {
        201: { description: "The account was opened", schema: accountSchema },
        422: { description: "Unsupported currency, or the account limit was reached" },
      },
      handler: async ({ user, body }) => {
        try {
          return { status: 201, body: accountView(await queries.openAccount(user, body)) };
        } catch (error) {
          if (error instanceof UnsupportedCurrency) {
            throw new HttpError(422, "unsupported_currency", error.message);
          }
          if (error instanceof AccountLimitReached) {
            throw new HttpError(422, "account_limit_reached", error.message);
          }
          throw error;
        }
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/accounts/{id}",
      tag: "Accounts",
      summary: "One of my accounts",
      access: "user",
      request: { params: idParam },
      responses: {
        200: { description: "The account", schema: accountSchema },
        404: { description: "No such account, or it belongs to someone else" },
      },
      handler: async ({ user, params }) => {
        const account = await queries.findAccount(user.id, params.id);
        if (!account) {
          throw notFound("account");
        }
        return { status: 200, body: accountView(account) };
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/accounts/{id}/entries",
      tag: "Accounts",
      summary: "Ledger entries of one of my accounts, newest first",
      description: "Cursor pagination: pass `nextCursor` of one page as `cursor` to get the next.",
      access: "user",
      request: {
        params: idParam,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "A page of entries",
          schema: z.object({
            entries: z.array(entrySchema),
            nextCursor: z.string().nullable().describe("Null on the last page"),
          }),
        },
        404: { description: "No such account, or it belongs to someone else" },
      },
      handler: async ({ user, params, query }) => {
        const page = await queries.listEntries(user.id, params.id, {
          limit: query.limit,
          after: query.cursor ? decodeCursor(query.cursor) : null,
        });
        if (!page) {
          throw notFound("account");
        }
        return {
          status: 200,
          body: {
            entries: page.entries.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
            nextCursor: page.next ? encodeCursor(page.next) : null,
          },
        };
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/recipients",
      tag: "Transfers",
      summary: "Accounts I can transfer to",
      description: "Accounts of the caller's sandbox that belong to someone else. No balances.",
      access: "user",
      responses: {
        200: {
          description: "Possible destinations",
          schema: z.object({
            recipients: z.array(
              z.object({ accountId: z.uuid(), accountName: z.string(), currency, ownerName: z.string() }),
            ),
          }),
        },
      },
      handler: async ({ user }) => ({ status: 200, body: { recipients: await queries.listRecipients(user) } }),
    }),

    defineRoute({
      method: "post",
      path: "/v1/transfers",
      tag: "Transfers",
      summary: "Transfer money between two accounts",
      description:
        "Atomic: the debit, the credit and the outgoing event are written in one transaction, or nothing is. " +
        "Safe to repeat: the same `Idempotency-Key` with the same body returns the original transfer and moves " +
        "no money again.",
      access: "user",
      request: {
        headers: z.object({
          "idempotency-key": z
            .string()
            .regex(/^[\x21-\x7e]{1,128}$/)
            .describe("Chosen by the client, unique per intended transfer. 1 to 128 printable ASCII characters"),
        }),
        body: z.object({
          fromAccountId: z.uuid().describe("One of the caller's accounts"),
          toAccountId: z.uuid().describe("An account of the caller, or one listed by `GET /v1/recipients`"),
          amount: z
            .string()
            .regex(/^[1-9]\d{0,17}$/)
            .describe("Positive integer in minor units (cents), as a string"),
        }),
      },
      responses: {
        201: { description: "The transfer was posted", schema: transferSchema },
        200: {
          description: "This key had already posted this transfer; nothing was written again",
          schema: transferSchema,
          headers: { "Idempotent-Replayed": "`true`" },
        },
        404: { description: "An account does not exist, belongs to someone else, or cannot receive this transfer" },
        422: {
          description:
            "Insufficient funds, same account on both sides, different currencies, or the key was used with another body",
        },
      },
      handler: async ({ user, headers, body, log }) => {
        const result = await transferMoney(deps.ledger, {
          actor: { type: "user", userId: user.id },
          fromAccountId: body.fromAccountId,
          toAccountId: body.toAccountId,
          amount: BigInt(body.amount),
          idempotencyKey: headers["idempotency-key"],
        });
        if (!result.replayed) {
          // After the commit and without waiting for it: delivery is someone else's job.
          deps.notifyDispatcher?.().catch((error: unknown) => {
            log.warn({ err: error }, "Could not notify the delivery process");
          });
        }
        const transfer = await queries.findTransfer(user.id, result.transferId);
        return {
          status: result.replayed ? 200 : 201,
          headers: result.replayed ? { "Idempotent-Replayed": "true" } : undefined,
          body: transferView(transfer!),
        };
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/transfers/{id}",
      tag: "Transfers",
      summary: "A transfer that moved money through one of my accounts",
      access: "user",
      request: { params: idParam },
      responses: {
        200: { description: "The transfer", schema: transferSchema },
        404: { description: "No such transfer, or none of its accounts is the caller's" },
      },
      handler: async ({ user, params }) => {
        const transfer = await queries.findTransfer(user.id, params.id);
        if (!transfer) {
          throw notFound("transfer");
        }
        return { status: 200, body: transferView(transfer) };
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/webhook-events",
      tag: "Webhooks",
      summary: "Outgoing events of my sandbox and what happened to each delivery",
      access: "user",
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) },
      responses: {
        200: { description: "Newest first", schema: z.object({ events: z.array(webhookEventSchema) }) },
      },
      handler: async ({ user, query }) => {
        const events = await queries.listWebhookEvents(user.sandboxId, query.limit);
        return {
          status: 200,
          body: {
            events: events.map(({ receivedAt, firstAttempt, deliveries, ...event }) => ({
              ...event,
              nextAttemptAt: event.status === "PENDING" ? event.nextAttemptAt.toISOString() : null,
              deliveredAt: event.deliveredAt?.toISOString() ?? null,
              createdAt: event.createdAt.toISOString(),
              receipt:
                receivedAt && firstAttempt !== null && deliveries !== null
                  ? { receivedAt: receivedAt.toISOString(), firstAttempt, deliveries }
                  : null,
            })),
          },
        };
      },
    }),

    defineRoute({
      method: "post",
      path: "/v1/webhook-receiver/failures",
      tag: "Webhooks",
      summary: "Make the built-in receiver refuse the next deliveries of my sandbox",
      description: "Lets the retries and their backoff be observed. Zero turns the simulation off.",
      access: "user",
      request: { body: z.object({ failures: z.number().int().min(0).max(5) }) },
      responses: {
        200: { description: "The receiver will refuse that many deliveries", schema: z.object({ failures: z.number().int() }) },
      },
      handler: async ({ user, body }) => {
        await queries.setReceiverFailures(user.sandboxId, body.failures);
        return { status: 200, body: { failures: body.failures } };
      },
    }),
  ];
}
