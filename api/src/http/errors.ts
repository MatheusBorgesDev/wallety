import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AccountNotFound, IdempotencyKeyReuse } from "../application/errors.js";
import {
  CrossSandboxTransfer,
  CurrencyMismatch,
  DomainError,
  InsufficientFunds,
  NonPositiveAmount,
  SameAccountTransfer,
  SystemAccountAsDestination,
} from "../domain/errors.js";

// Every error response of the API has this shape.
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().describe("Stable, machine-readable error code"),
      message: z.string().describe("Human-readable explanation"),
      details: z.unknown().optional().describe("Present on validation errors: the offending fields"),
      requestId: z.string().optional().describe("Correlation id of the request, also in X-Request-Id"),
    }),
  })
  .meta({ id: "Error" });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: { details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type Mapping = { status: number; code: string; message?: string };

// How a business-rule violation becomes a response. Anything that would reveal that
// someone else's resource exists is answered exactly like a resource that does not exist.
const ACCOUNT_NOT_FOUND: Mapping = { status: 404, code: "account_not_found", message: "Account not found" };
const domainErrorMappings: [new (...args: never[]) => DomainError, Mapping][] = [
  [AccountNotFound, ACCOUNT_NOT_FOUND],
  [CrossSandboxTransfer, ACCOUNT_NOT_FOUND],
  [SystemAccountAsDestination, ACCOUNT_NOT_FOUND],
  [InsufficientFunds, { status: 422, code: "insufficient_funds", message: "Insufficient funds" }],
  [IdempotencyKeyReuse, { status: 422, code: "idempotency_key_reuse" }],
  [NonPositiveAmount, { status: 422, code: "invalid_amount", message: "The amount must be positive" }],
  [SameAccountTransfer, { status: 422, code: "same_account", message: "Cannot transfer to the same account" }],
  [CurrencyMismatch, { status: 422, code: "currency_mismatch", message: "Both accounts must use the same currency" }],
];

export function toHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) {
    return error;
  }
  for (const [type, mapping] of domainErrorMappings) {
    if (error instanceof type) {
      return new HttpError(mapping.status, mapping.code, mapping.message ?? (error as Error).message);
    }
  }
  // Errors raised by the body parser carry a `type`.
  const parserError = error as { type?: string } | null;
  if (parserError?.type === "entity.too.large") {
    return new HttpError(413, "payload_too_large", "The request body is too large");
  }
  if (parserError?.type === "entity.parse.failed") {
    return new HttpError(400, "invalid_json", "The request body is not valid JSON");
  }
  return null;
}

function send(req: Request, res: Response, error: HttpError): void {
  for (const [name, value] of Object.entries(error.options.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.options.details === undefined ? {} : { details: error.options.details }),
      requestId: String(req.id),
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  send(req, res, new HttpError(404, "not_found", "Not found"));
}

// Four arguments: Express recognizes an error handler by its arity.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const known = toHttpError(err);
  if (known) {
    send(req, res, known);
    return;
  }
  // The cause goes to the log, never to the client.
  req.log.error({ err }, "Unhandled error");
  send(req, res, new HttpError(500, "internal_error", "Internal server error"));
}
