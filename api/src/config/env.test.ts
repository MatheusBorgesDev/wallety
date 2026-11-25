import { describe, it, expect } from "vitest";
import { loadEnv } from "./env.js";

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
    });
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
