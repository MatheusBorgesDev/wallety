import { describe, it, expect } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("returns parsed config with a default port", () => {
    expect(loadEnv({ DATABASE_URL: "postgres://x" })).toEqual({
      databaseUrl: "postgres://x",
      port: 3000,
    });
  });

  it("parses PORT when provided", () => {
    expect(loadEnv({ DATABASE_URL: "postgres://x", PORT: "4000" }).port).toBe(
      4000,
    );
  });
});
