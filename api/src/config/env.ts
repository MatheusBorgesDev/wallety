export type AppEnv = {
  databaseUrl: string;
  port: number;
  webhookSigningSecret: string;
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
  return { databaseUrl, port, webhookSigningSecret };
}
