import { describe, it, expect } from "vitest";
import { loadApiEnv, loadEnv } from "./env.js";

const complete = {
  DATABASE_URL: "postgres://x",
  WEBHOOK_SIGNING_SECRET: "a-signing-secret-with-at-least-32-chars",
};

describe("loadEnv", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({ ...complete, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("returns parsed config with a default port", () => {
    expect(loadEnv(complete)).toEqual({
      databaseUrl: "postgres://x",
      port: 3000,
      webhookSigningSecret: "a-signing-secret-with-at-least-32-chars",
      corsOrigins: [],
      trustProxy: undefined,
    });
  });

  it("reads the allowed browser origins as a list", () => {
    expect(loadEnv({ ...complete, CORS_ORIGINS: "https://a.example, https://b.example" }).corsOrigins).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("reads the number of trusted proxies and refuses anything that is not a count", () => {
    expect(loadEnv({ ...complete, TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(() => loadEnv({ ...complete, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
  });

  it("parses PORT when provided", () => {
    expect(loadEnv({ ...complete, PORT: "4000" }).port).toBe(4000);
  });

  it("throws when the webhook signing secret is missing or too short to be a secret", () => {
    expect(() => loadEnv({ ...complete, WEBHOOK_SIGNING_SECRET: undefined })).toThrow(/WEBHOOK_SIGNING_SECRET/);
    expect(() => loadEnv({ ...complete, WEBHOOK_SIGNING_SECRET: "short" })).toThrow(/WEBHOOK_SIGNING_SECRET/);
  });

  it("never puts the secret in an error message", () => {
    try {
      loadEnv({ ...complete, WEBHOOK_SIGNING_SECRET: "short-secret-value" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("short-secret-value");
    }
  });
});

describe("loadApiEnv", () => {
  const api = { ...complete, JWT_SECRET: "a-jwt-secret-with-at-least-32-characters" };

  it("adds the token secret and a default lifetime of two hours", () => {
    expect(loadApiEnv(api)).toMatchObject({ jwtSecret: api.JWT_SECRET, accessTokenTtlSeconds: 7200 });
  });

  it("throws when the token secret is missing or too short, without echoing it", () => {
    expect(() => loadApiEnv(complete)).toThrow(/JWT_SECRET/);
    expect(() => loadApiEnv({ ...complete, JWT_SECRET: "short-secret" })).toThrow(/at least 32/);
    expect(() => loadApiEnv({ ...complete, JWT_SECRET: "short-secret" })).not.toThrow(/short-secret/);
  });

  it("tells the delivery process only when its address is configured", () => {
    expect(loadApiEnv(api).dispatch).toBeUndefined();
    expect(loadApiEnv({ ...api, DISPATCH_URL: "http://worker:3001" }).dispatch).toEqual({
      url: "http://worker:3001",
      auth: "none",
    });
    expect(loadApiEnv({ ...api, DISPATCH_URL: "https://w.example", DISPATCH_AUTH: "google-id-token" }).dispatch?.auth).toBe(
      "google-id-token",
    );
    expect(() => loadApiEnv({ ...api, DISPATCH_URL: "https://w.example", DISPATCH_AUTH: "magic" })).toThrow(/DISPATCH_AUTH/);
  });

  it("enables the cleanup only with both its database login and its secret", () => {
    const purge = { PURGE_DATABASE_URL: "postgres://purger", PURGE_SECRET: "a-purge-secret-with-at-least-32-chars" };
    expect(loadApiEnv(api).purge).toBeUndefined();
    expect(loadApiEnv({ ...api, ...purge }).purge).toEqual({ databaseUrl: "postgres://purger", secret: purge.PURGE_SECRET });
    expect(() => loadApiEnv({ ...api, PURGE_SECRET: purge.PURGE_SECRET })).toThrow(/set together/);
    expect(() => loadApiEnv({ ...api, PURGE_DATABASE_URL: "postgres://purger" })).toThrow(/set together/);
    expect(() => loadApiEnv({ ...api, ...purge, PURGE_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("caps demo sandboxes at 200 unless told otherwise", () => {
    expect(loadApiEnv(api).maxDemoSandboxes).toBe(200);
    expect(loadApiEnv({ ...api, MAX_DEMO_SANDBOXES: "3" }).maxDemoSandboxes).toBe(3);
    expect(() => loadApiEnv({ ...api, MAX_DEMO_SANDBOXES: "many" })).toThrow(/MAX_DEMO_SANDBOXES/);
  });

  it("refuses a token lifetime that is not a positive number of seconds", () => {
    expect(() => loadApiEnv({ ...api, ACCESS_TOKEN_TTL_SECONDS: "soon" })).toThrow(/ACCESS_TOKEN_TTL_SECONDS/);
    expect(loadApiEnv({ ...api, ACCESS_TOKEN_TTL_SECONDS: "600" }).accessTokenTtlSeconds).toBe(600);
  });
});
