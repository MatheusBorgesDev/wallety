import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { createArgon2Hasher } from "./argon2-hasher.js";
import { createJwtTokens } from "./jwt-tokens.js";

const secret = "a-test-jwt-secret-with-at-least-32-chars";

describe("argon2 password hasher", () => {
  const hasher = createArgon2Hasher();

  it("stores an argon2id hash with its parameters, never the password", async () => {
    const hash = await hasher.hash("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain("correct horse battery");
  });

  it("verifies the right password and refuses a wrong one", async () => {
    const hash = await hasher.hash("correct horse battery");
    expect(await hasher.verify(hash, "correct horse battery")).toBe(true);
    expect(await hasher.verify(hash, "correct horse batterz")).toBe(false);
  });

  it("gives two hashes of the same password different salts", async () => {
    expect(await hasher.hash("same password")).not.toBe(await hasher.hash("same password"));
  });

  it("answers false when there is no hash, whatever the password", async () => {
    expect(await hasher.verify(null, "decoy password, matches nothing")).toBe(false);
  });
});

describe("JWT access tokens", () => {
  const at = (iso: string) => () => new Date(iso);

  it("issues a token that verifies back to the user and its expiry", async () => {
    const tokens = createJwtTokens({ secret, ttlSeconds: 7200, now: at("2026-01-01T00:00:00Z") });
    const issued = await tokens.issue("user-1");
    expect(issued.expiresAt).toEqual(new Date("2026-01-01T02:00:00Z"));
    expect(await tokens.verify(issued.token)).toEqual({ userId: "user-1", expiresAt: issued.expiresAt });
  });

  it("refuses an expired token", async () => {
    const issued = await createJwtTokens({ secret, ttlSeconds: 60, now: at("2026-01-01T00:00:00Z") }).issue("user-1");
    const later = createJwtTokens({ secret, ttlSeconds: 60, now: at("2026-01-01T00:01:01Z") });
    expect(await later.verify(issued.token)).toBeNull();
  });

  it("refuses a token signed with another secret, a tampered one and garbage", async () => {
    const tokens = createJwtTokens({ secret, ttlSeconds: 60 });
    const foreign = await createJwtTokens({ secret: `${secret}-other`, ttlSeconds: 60 }).issue("user-1");
    const own = await tokens.issue("user-1");
    const [header, payload, signature] = own.token.split(".") as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "user-2", iss: "wallety", aud: "wallety-api", exp: 9999999999 })).toString("base64url");
    expect(await tokens.verify(foreign.token)).toBeNull();
    expect(await tokens.verify(`${header}.${forgedPayload}.${signature}`)).toBeNull();
    expect(payload).not.toBe(forgedPayload);
    expect(await tokens.verify("not-a-token")).toBeNull();
  });

  it("refuses an unsigned token and one made for another audience", async () => {
    const tokens = createJwtTokens({ secret, ttlSeconds: 60 });
    const claims = Buffer.from(JSON.stringify({ sub: "user-1", iss: "wallety", aud: "wallety-api", exp: 9999999999 })).toString("base64url");
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${claims}.`;
    const otherAudience = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuer("wallety")
      .setAudience("another-service")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    expect(await tokens.verify(unsigned)).toBeNull();
    expect(await tokens.verify(otherAudience)).toBeNull();
  });
});
