export type AppEnv = {
  databaseUrl: string;
  port: number;
  webhookSigningSecret: string;
  // Origins allowed to call the API from a browser. Empty: no cross-origin access.
  corsOrigins: string[];
  // Reverse proxies in front of the process. Unset: the socket address is the client.
  trustProxy: number | undefined;
};

const MIN_SECRET_LENGTH = 32;

// Fails fast: a process with incomplete configuration must not start.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required env var: DATABASE_URL");
  }
  const port = source.PORT ? Number(source.PORT) : 3000;
  if (Number.isNaN(port)) {
    throw new Error(`Invalid PORT: ${source.PORT}`);
  }
  const webhookSigningSecret = source.WEBHOOK_SIGNING_SECRET;
  if (!webhookSigningSecret || webhookSigningSecret.length < MIN_SECRET_LENGTH) {
    // The value itself never goes into the message.
    throw new Error(`WEBHOOK_SIGNING_SECRET must be set and have at least ${MIN_SECRET_LENGTH} characters`);
  }
  const corsOrigins = (source.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const trustProxy = source.TRUST_PROXY ? Number(source.TRUST_PROXY) : undefined;
  if (trustProxy !== undefined && (!Number.isInteger(trustProxy) || trustProxy < 0)) {
    throw new Error(`Invalid TRUST_PROXY: ${source.TRUST_PROXY}`);
  }
  return { databaseUrl, port, webhookSigningSecret, corsOrigins, trustProxy };
}

export type ApiEnv = AppEnv & {
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  // Where to tell the delivery process that a transfer was posted. Unset: nobody is told,
  // which is right where that process polls the outbox on its own.
  dispatch: { url: string; auth: "none" | "google-id-token" } | undefined;
};

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;

// What only the API process needs, on top of what every process needs.
export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const jwtSecret = source.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be set and have at least ${MIN_SECRET_LENGTH} characters`);
  }
  const accessTokenTtlSeconds = source.ACCESS_TOKEN_TTL_SECONDS
    ? Number(source.ACCESS_TOKEN_TTL_SECONDS)
    : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds <= 0) {
    throw new Error(`Invalid ACCESS_TOKEN_TTL_SECONDS: ${source.ACCESS_TOKEN_TTL_SECONDS}`);
  }
  const dispatchAuth = source.DISPATCH_AUTH ?? "none";
  if (dispatchAuth !== "none" && dispatchAuth !== "google-id-token") {
    throw new Error(`Invalid DISPATCH_AUTH: ${source.DISPATCH_AUTH}`);
  }
  const dispatch: ApiEnv["dispatch"] = source.DISPATCH_URL ? { url: source.DISPATCH_URL, auth: dispatchAuth } : undefined;
  return { ...loadEnv(source), jwtSecret, accessTokenTtlSeconds, dispatch };
}
