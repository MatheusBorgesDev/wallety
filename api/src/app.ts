import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { loadApiEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { createAuthenticator } from "./http/authenticate.js";
import { mountDocs } from "./http/docs.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { mountRoutes, type AnyRoute } from "./http/route.js";
import { createPessimisticLedger } from "./infra/db/pessimistic-ledger.js";
import { createPurger, type Purger } from "./infra/db/purge.js";
import { createRateLimiter } from "./infra/db/rate-limiter.js";
import { createWalletQueries } from "./infra/db/wallet-queries.js";
import { createUserDirectory, createWorkspace } from "./infra/db/workspace.js";
import { createArgon2Hasher } from "./infra/security/argon2-hasher.js";
import { createJwtTokens } from "./infra/security/jwt-tokens.js";
import { createDispatchNotifier, type DispatchNotifier } from "./infra/webhooks/dispatch-notifier.js";
import { createHttpLogger } from "./observability/http-logger.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { healthRoutes } from "./routes/health.js";
import { internalRoutes } from "./routes/internal.js";
import { authRoutes, defaultAuthRateLimits, type AuthRateLimits } from "./routes/v1/auth.js";
import { walletRoutes } from "./routes/v1/wallet.js";
import { transferPostedWebhook, webhookReceiverRoute } from "./routes/webhook-receiver.js";

type AppOptions = {
  logger?: Logger;
  webhookSigningSecret?: string;
  authRateLimits?: AuthRateLimits;
  notifyDispatcher?: DispatchNotifier;
  maxDemoSandboxes?: number;
  // Replaces the cleanup built from the environment; null turns it off.
  purger?: Purger | null;
  now?: () => Date;
};

const apiDescription = [
  "A digital wallet API built on a double-entry ledger.",
  "",
  "- Money is a string of an integer in minor units (cents): `\"1050\"` is 10.50.",
  "- `POST /v1/transfers` requires an `Idempotency-Key` header. Repeating a request with the same key and body",
  "  returns the original transfer with `Idempotent-Replayed: true`.",
  "- Errors share one shape: `{ \"error\": { \"code\", \"message\", \"details\"?, \"requestId\" } }`.",
  "- A resource that belongs to someone else is answered exactly like one that does not exist: `404`.",
].join("\n");

export function createApp(options: AppOptions = {}): Express {
  const env = loadApiEnv();
  const logger = options.logger ?? defaultLogger();
  const webhookSigningSecret = options.webhookSigningSecret ?? env.webhookSigningSecret;

  const now = options.now ?? (() => new Date());
  const tokens = createJwtTokens({ secret: env.jwtSecret, ttlSeconds: env.accessTokenTtlSeconds, now });

  const purger = options.purger === undefined ? (env.purge ? createPurger(env.purge.databaseUrl) : null) : options.purger;

  const routes: AnyRoute[] = [
    ...healthRoutes(prisma),
    ...(purger && env.purge ? internalRoutes({ purger, purgeSecret: env.purge.secret, now }) : []),
    ...authRoutes({
      prisma,
      workspace: createWorkspace(prisma),
      directory: createUserDirectory(prisma),
      hasher: createArgon2Hasher(),
      tokens,
      rateLimits: options.authRateLimits ?? defaultAuthRateLimits,
      demoPolicy: { maxDemoSandboxes: options.maxDemoSandboxes ?? env.maxDemoSandboxes },
      purgeSome: purger ? () => purger.purge({ now: now(), maxSandboxes: 5 }) : undefined,
      now,
    }),
    ...walletRoutes({
      queries: createWalletQueries(prisma),
      ledger: createPessimisticLedger(prisma),
      notifyDispatcher: options.notifyDispatcher ?? (env.dispatch ? createDispatchNotifier(env.dispatch) : undefined),
    }),
    webhookReceiverRoute({ prisma, signingSecret: webhookSigningSecret }),
  ];
  const document = buildOpenApiDocument(routes, [transferPostedWebhook], {
    title: "Wallety API",
    version: "1.0.0",
    description: apiDescription,
  });

  const app = express();
  app.disable("x-powered-by");
  if (env.trustProxy !== undefined) {
    // Number of reverse proxies in front of the process, so `req.ip` is the client address.
    app.set("trust proxy", env.trustProxy);
  }
  app.use(createHttpLogger(logger));
  app.use(helmet());
  if (env.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: env.corsOrigins,
        allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
        exposedHeaders: ["Idempotent-Replayed", "Retry-After", "X-Request-Id"],
        maxAge: 600,
      }),
    );
  }
  mountRoutes(app, routes, {
    authenticate: createAuthenticator({ prisma, tokens, now }),
    hitRateLimit: createRateLimiter(prisma, now),
  });
  mountDocs(app, document);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function defaultLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");
  return createLogger({ level });
}

export const app = createApp();
