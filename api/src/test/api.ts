import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../app.js";
import { createLogger } from "../observability/logger.js";
import type { AuthRateLimits } from "../routes/v1/auth.js";

// Limits high enough that a suite never trips them by accident.
export const relaxedRateLimits: AuthRateLimits = {
  demoPerIp: { limit: 100_000, windowSeconds: 3600 },
  registerPerIp: { limit: 100_000, windowSeconds: 3600 },
  loginPerIp: { limit: 100_000, windowSeconds: 300 },
  loginPerEmail: { limit: 100_000, windowSeconds: 900 },
};

export function createTestApp(options: Parameters<typeof createApp>[0] = {}): Express {
  return createApp({ logger: createLogger({ level: "silent" }), authRateLimits: relaxedRateLimits, ...options });
}

export function captureLogs() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, logger: createLogger({ level: "trace", destination }) };
}

export const TEST_PASSWORD = "correct horse battery staple";

export type SignedInUser = { token: string; userId: string; email: string };

export async function register(app: Express, overrides: { email?: string; password?: string } = {}): Promise<SignedInUser> {
  const email = overrides.email ?? `user-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/v1/auth/register")
    .send({ email, password: overrides.password ?? TEST_PASSWORD, displayName: "Test User" });
  if (response.status !== 201) {
    throw new Error(`Registration failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { token: response.body.accessToken, userId: response.body.user.id, email };
}

export const bearer = (user: SignedInUser) => ({ Authorization: `Bearer ${user.token}` });

export type Wallet = SignedInUser & {
  // The funded account opened at registration.
  accountId: string;
  // The account of the sample recipient in the same sandbox.
  recipientAccountId: string;
};

// A registered user together with the ids a test needs to move money.
export async function registerWithWallet(app: Express): Promise<Wallet> {
  const user = await register(app);
  const accounts = await request(app).get("/v1/accounts").set(bearer(user));
  const recipients = await request(app).get("/v1/recipients").set(bearer(user));
  return {
    ...user,
    accountId: accounts.body.accounts[0].id,
    recipientAccountId: recipients.body.recipients[0].accountId,
  };
}

export function postTransfer(
  app: Express,
  user: SignedInUser,
  body: { fromAccountId: string; toAccountId: string; amount: string },
  idempotencyKey: string = randomUUID(),
) {
  return request(app).post("/v1/transfers").set(bearer(user)).set("Idempotency-Key", idempotencyKey).send(body);
}

// A demo user together with the ids a test needs to move money.
export async function startDemo(app: Express): Promise<Wallet & { sandboxExpiresAt: string }> {
  const response = await request(app).post("/v1/auth/demo");
  if (response.status !== 201) {
    throw new Error(`Demo failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const user = { token: response.body.accessToken, userId: response.body.user.id, email: "" };
  const accounts = await request(app).get("/v1/accounts").set(bearer(user));
  const recipients = await request(app).get("/v1/recipients").set(bearer(user));
  return {
    ...user,
    accountId: accounts.body.accounts[0].id,
    recipientAccountId: recipients.body.recipients[0].accountId,
    sandboxExpiresAt: response.body.sandboxExpiresAt,
  };
}
