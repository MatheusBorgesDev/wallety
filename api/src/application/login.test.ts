import { describe, it, expect } from "vitest";
import { InvalidCredentials } from "./errors.js";
import type { AccessTokens, PasswordHasher, UserDirectory } from "./identity.js";
import { login } from "./login.js";

function setup() {
  const verifications: (string | null)[] = [];
  const logins: { userId: string; at: Date }[] = [];
  const hasher: PasswordHasher = {
    hash: async (password) => `hashed:${password}`,
    verify: async (hash, password) => {
      verifications.push(hash);
      return hash === `hashed:${password}`;
    },
  };
  const directory: UserDirectory = {
    findCredentialsByEmail: async (email) =>
      email === "ada@example.com" ? { userId: "user-1", passwordHash: "hashed:correct horse" } : null,
    recordLogin: async (userId, at) => void logins.push({ userId, at }),
  };
  const tokens: AccessTokens = {
    issue: async (userId) => ({ token: `token-for-${userId}`, expiresAt: new Date("2026-01-01T02:00:00Z") }),
  };
  const now = () => new Date("2026-01-01T00:00:00Z");
  return { deps: { directory, hasher, tokens, now }, verifications, logins };
}

describe("login", () => {
  it("issues a token and records the login when the password matches", async () => {
    const { deps, logins } = setup();
    const result = await login(deps, { email: "ada@example.com", password: "correct horse" });
    expect(result).toEqual({
      userId: "user-1",
      accessToken: { token: "token-for-user-1", expiresAt: new Date("2026-01-01T02:00:00Z") },
    });
    expect(logins).toEqual([{ userId: "user-1", at: new Date("2026-01-01T00:00:00Z") }]);
  });

  it("finds the user whatever the case and spacing of the email", async () => {
    const { deps } = setup();
    const result = await login(deps, { email: "  Ada@Example.COM ", password: "correct horse" });
    expect(result.userId).toBe("user-1");
  });

  it("fails the same way for a wrong password and for an unknown email", async () => {
    const { deps, logins } = setup();
    const wrongPassword = await login(deps, { email: "ada@example.com", password: "nope" }).catch((error) => error);
    const unknownEmail = await login(deps, { email: "nobody@example.com", password: "nope" }).catch((error) => error);
    expect(wrongPassword).toBeInstanceOf(InvalidCredentials);
    expect(unknownEmail).toBeInstanceOf(InvalidCredentials);
    expect(unknownEmail.message).toBe(wrongPassword.message);
    expect(logins).toEqual([]);
  });

  it("does the work of a verification even when the email is unknown", async () => {
    const { deps, verifications } = setup();
    await login(deps, { email: "nobody@example.com", password: "nope" }).catch(() => {});
    expect(verifications).toEqual([null]);
  });

  it("refuses a user that has no password, such as a sample recipient", async () => {
    const { deps } = setup();
    deps.directory.findCredentialsByEmail = async () => ({ userId: "user-2", passwordHash: null });
    await expect(login(deps, { email: "x@example.com", password: "" })).rejects.toBeInstanceOf(InvalidCredentials);
  });
});
