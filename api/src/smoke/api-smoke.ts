import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// Smoke check for a running stack, through the public API only: register, transfer with a
// repeated idempotency key, and wait until the delivery process has delivered the event
// after one simulated receiver failure. Exits non-zero on the first thing that is off.
const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const TIMEOUT_MS = 30_000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

type CallOptions = { token?: string; body?: unknown; headers?: Record<string, string> };

async function call(method: string, path: string, options: CallOptions = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("application/json");
  return { status: response.status, headers: response.headers, body: (isJson ? JSON.parse(text) : {}) as Json };
}

function expectStatus(step: string, response: { status: number; body: Json }, status: number) {
  if (response.status !== status) {
    throw new Error(`${step}: expected ${status}, got ${response.status} ${JSON.stringify(response.body)}`);
  }
}

async function main() {
  const email = `smoke-${randomUUID()}@example.com`;
  const password = `smoke-${randomUUID()}`;

  for (const path of ["/docs", "/docs/swagger-ui-bundle.js", "/openapi.json"]) {
    expectStatus(`GET ${path}`, await call("GET", path), 200);
  }

  const registered = await call("POST", "/v1/auth/register", { body: { email, password, displayName: "Smoke check" } });
  expectStatus("register", registered, 201);
  const wrong = await call("POST", "/v1/auth/login", { body: { email, password: `${password}x` } });
  expectStatus("login with a wrong password", wrong, 401);
  const login = await call("POST", "/v1/auth/login", { body: { email, password } });
  expectStatus("login", login, 200);
  const token: string = login.body.accessToken;
  expectStatus("GET /v1/me without a token", await call("GET", "/v1/me"), 401);

  const accounts = await call("GET", "/v1/accounts", { token });
  const recipients = await call("GET", "/v1/recipients", { token });
  expectStatus("accounts", accounts, 200);
  expectStatus("recipients", recipients, 200);
  const from: string = accounts.body.accounts[0].id;
  const to: string = recipients.body.recipients[0].accountId;

  // The opening balance posted an event too. Wait for it, so the simulated failure below
  // is spent on the transfer of this check and not on that one.
  await waitFor("the opening event to be delivered", async () => {
    const events = await call("GET", "/v1/webhook-events", { token });
    return events.body.events.length === 1 && events.body.events[0].status === "DELIVERED" ? true : null;
  });

  const failures = await call("POST", "/v1/webhook-receiver/failures", { token, body: { failures: 1 } });
  expectStatus("receiver failures", failures, 200);

  const transfer = { fromAccountId: from, toAccountId: to, amount: "2500" };
  const headers = { "Idempotency-Key": randomUUID() };
  const posted = await call("POST", "/v1/transfers", { token, body: transfer, headers });
  const replayed = await call("POST", "/v1/transfers", { token, body: transfer, headers });
  expectStatus("transfer", posted, 201);
  expectStatus("repeated transfer", replayed, 200);
  if (replayed.headers.get("idempotent-replayed") !== "true" || replayed.body.id !== posted.body.id) {
    throw new Error("The repeated transfer was not answered as a replay of the first");
  }

  const balance = (await call("GET", `/v1/accounts/${from}`, { token })).body.balance;
  if (balance !== "97500") {
    throw new Error(`Expected a balance of 97500 after one transfer of 2500, got ${balance}`);
  }
  expectStatus("statement", await call("GET", `/v1/accounts/${from}/entries`, { token }), 200);
  expectStatus("open an account", await call("POST", "/v1/accounts", { token, body: { name: "Savings", currency: "USD" } }), 201);

  // A demo needs no credentials and gets the same funded account.
  const demo = await call("POST", "/v1/auth/demo");
  expectStatus("demo", demo, 201);
  const demoAccounts = await call("GET", "/v1/accounts", { token: demo.body.accessToken });
  if (demoAccounts.body.accounts?.[0]?.balance !== "100000") {
    throw new Error(`Expected the demo account to open with 100000, got ${JSON.stringify(demoAccounts.body)}`);
  }

  // The cleanup refuses a caller without its secret and, with it, runs on its own database login.
  expectStatus("cleanup without the secret", await call("POST", "/internal/purge"), 401);
  if (process.env.SMOKE_PURGE_SECRET) {
    const purge = await call("POST", "/internal/purge", { token: process.env.SMOKE_PURGE_SECRET });
    expectStatus("cleanup", purge, 200);
    if (purge.body.sandboxes !== 0) {
      throw new Error(`Nothing has expired yet, but the cleanup removed ${purge.body.sandboxes} sandbox(es)`);
    }
  }

  const event = await waitFor("the transfer event to be delivered", async () => {
    const events = await call("GET", "/v1/webhook-events", { token });
    expectStatus("webhook events", events, 200);
    const found = events.body.events.find((candidate: Json) => candidate.transferId === posted.body.id);
    return found?.status === "DELIVERED" && found.receipt ? found : null;
  });
  console.log(
    JSON.stringify({
      result: "ok",
      transferId: posted.body.id,
      eventId: event.id,
      attempts: event.attempts,
      deliveries: event.receipt.deliveries,
    }),
  );
  if (event.attempts !== 2 || event.receipt.firstAttempt !== 2) {
    throw new Error("Expected one refused delivery and then an accepted one");
  }
}

async function waitFor<T>(what: string, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const result = await check();
    if (result !== null) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
    }
    await sleep(250);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
