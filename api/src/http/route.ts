import express, { type Express, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "./errors.js";

export type AuthenticatedUser = { id: string; sandboxId: string };

export type RateLimitRule = { key: string; limit: number; windowSeconds: number };

type Shape = z.ZodObject | undefined;
type Parsed<S> = S extends z.ZodType ? z.infer<S> : undefined;

export type RouteRequest<P extends Shape, Q extends Shape, H extends Shape, B extends z.ZodType | undefined> = {
  params?: P;
  query?: Q;
  // Header names in lower case.
  headers?: H;
  body?: B;
};

export type RouteContext<P extends Shape, Q extends Shape, H extends Shape, B extends z.ZodType | undefined, A> = {
  params: Parsed<P>;
  query: Parsed<Q>;
  headers: Parsed<H>;
  body: Parsed<B>;
  user: A extends "user" ? AuthenticatedUser : undefined;
  // The exact bytes received. Only set for routes declared with `rawBody`.
  rawBody: Buffer | undefined;
  ip: string;
  log: Request["log"];
};

export type RouteResult = { status: number; body?: unknown; headers?: Record<string, string> };

export type ResponseSpec = {
  description: string;
  schema?: z.ZodType;
  headers?: Record<string, string>;
};

// One declaration per route. The same object validates the request, registers the
// handler in Express and produces the OpenAPI entry, so the three cannot drift apart.
export type RouteDefinition<
  P extends Shape = Shape,
  Q extends Shape = Shape,
  H extends Shape = Shape,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  A extends "public" | "user" = "public" | "user",
> = {
  method: "get" | "post";
  // OpenAPI style: `/v1/accounts/{id}`.
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: A;
  request?: RouteRequest<P, Q, H, B>;
  // The handler needs the bytes as they arrived, for example to verify a signature over
  // them. The body is then not parsed nor validated; its schema only documents it.
  rawBody?: boolean;
  responses: Record<number, ResponseSpec>;
  // Limits checked after validation and before the handler. Every request counts.
  rateLimit?: (input: { ip: string; body: Parsed<B> }) => RateLimitRule[];
  handler: (context: RouteContext<P, Q, H, B, A>) => Promise<RouteResult>;
};

// Erased form, for lists of routes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteDefinition<any, any, any, any, any>;

export function defineRoute<
  P extends Shape = undefined,
  Q extends Shape = undefined,
  H extends Shape = undefined,
  B extends z.ZodType | undefined = undefined,
  A extends "public" | "user" = "public",
>(route: RouteDefinition<P, Q, H, B, A>): RouteDefinition<P, Q, H, B, A> {
  return route;
}

export type RouteDependencies = {
  authenticate: (request: Request) => Promise<AuthenticatedUser>;
  // Returns the seconds to wait when the limit is exceeded, or null when the request may proceed.
  hitRateLimit: (rule: RateLimitRule) => Promise<number | null>;
};

function parsePart<S extends z.ZodType>(schema: S | undefined, value: unknown, where: string): z.infer<S> | undefined {
  if (!schema) {
    return undefined;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "validation_error", `Invalid request ${where}`, {
      details: result.error.issues.map((issue) => ({ in: where, path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

export function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ":$1");
}

function toHandler(route: AnyRoute, dependencies: RouteDependencies): RequestHandler {
  return async (req, res) => {
    const user = route.access === "user" ? await dependencies.authenticate(req) : undefined;
    const context = {
      params: parsePart(route.request?.params, req.params, "path"),
      query: parsePart(route.request?.query, req.query, "query"),
      headers: parsePart(route.request?.headers, req.headers, "headers"),
      body: route.rawBody ? undefined : parsePart(route.request?.body, req.body, "body"),
      user,
      rawBody: route.rawBody && Buffer.isBuffer(req.body) ? req.body : undefined,
      ip: req.ip ?? "unknown",
      log: req.log,
    };
    for (const rule of route.rateLimit?.({ ip: context.ip, body: context.body }) ?? []) {
      const retryAfterSeconds = await dependencies.hitRateLimit(rule);
      if (retryAfterSeconds !== null) {
        throw new HttpError(429, "rate_limited", "Too many requests", {
          headers: { "Retry-After": String(retryAfterSeconds) },
        });
      }
    }
    const result = await route.handler(context);
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(name, value);
    }
    if (result.body === undefined) {
      res.status(result.status).end();
    } else {
      res.status(result.status).json(result.body);
    }
  };
}

const BODY_LIMIT = "16kb";
const parseJson = express.json({ limit: BODY_LIMIT });
const keepRaw = express.raw({ type: "*/*", limit: "64kb" });

export function mountRoutes(app: Express, routes: AnyRoute[], dependencies: RouteDependencies): void {
  for (const route of routes) {
    // Each route gets its own body parser: there is no global one that could parse a body
    // before a route that needs the raw bytes sees it.
    const parser = route.rawBody ? keepRaw : parseJson;
    app[route.method](toExpressPath(route.path), parser, toHandler(route, dependencies));
  }
}
