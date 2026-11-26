import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "../../db/prisma.js";
import { provisionSandbox } from "../../application/provision-sandbox.js";
import { createWorkspace } from "../../infra/db/workspace.js";
import { bearer, captureLogs, createTestApp, register, relaxedRateLimits, TEST_PASSWORD } from "../../test/api.js";
import { resetDb, disconnectDb } from "../../test/db.js";
import { balanceOf, globalSum, systemAccount } from "../../test/fixtures.js";

const app = createTestApp();

const withoutRequestId = (body: { error: { requestId?: string } }) => ({ ...body.error, requestId: undefined });

describe("registration", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("creates the user, signs it in and never returns the password or its hash", async () => {
    const res = await request(app)
      .post("/v1/auth/register")
      .send({ email: "Ada@Example.com", password: TEST_PASSWORD, displayName: " Ada " });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      user: { id: expect.any(String), email: "ada@example.com", displayName: "Ada" },
      accessToken: expect.any(String),
      tokenType: "Bearer",
      expiresAt: expect.any(String),
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(res.body)).not.toContain(stored.passwordHash);
  });

  it("opens a sandbox with a funded account and a sample recipient; the money comes from the system account", async () => {
    const user = await register(app);

    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      include: { sandbox: { include: { users: true } }, accounts: true },
    });
    expect(owner.sandbox.kind).toBe("REGISTERED");
    expect(owner.sandbox.users).toHaveLength(2);
    expect(owner.accounts).toHaveLength(1);
    expect(await balanceOf(owner.accounts[0]!.id)).toBe(100_000n);
    expect(await balanceOf((await systemAccount()).id)).toBe(-100_000n);
    expect(await globalSum()).toBe(0n);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it("refuses an email that is already registered, whatever its case, and creates nothing", async () => {
    await register(app, { email: "ada@example.com" });
    const sandboxes = await prisma.sandbox.count();

    const res = await request(app)
      .post("/v1/auth/register")
      .send({ email: "ADA@example.com", password: TEST_PASSWORD, displayName: "Other" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_already_registered");
    expect(await prisma.sandbox.count()).toBe(sandboxes);
    expect(await prisma.user.count()).toBe(2);
  });

  it("is all or nothing: a failure after the sandbox was built leaves no row behind", async () => {
    const workspace = createWorkspace(prisma);
    const attempt = workspace.transaction(async (tx) => {
      await provisionSandbox(tx, {
        kind: "REGISTERED",
        expiresAt: null,
        owner: { email: "ghost@example.com", passwordHash: "x", displayName: "Ghost" },
      });
      throw new Error("connection lost before commit");
    });

    await expect(attempt).rejects.toThrow("connection lost before commit");
    for (const count of [prisma.sandbox.count(), prisma.user.count(), prisma.transfer.count(), prisma.ledgerEntry.count()]) {
      expect(await count).toBe(0);
    }
  });

  it("explains which fields are invalid", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "not-an-email", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details.map((detail: { path: string }) => detail.path).sort()).toEqual([
      "displayName",
      "email",
      "password",
    ]);
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a body that is not JSON and one that is too large, in the common error shape", async () => {
    const malformed = await request(app).post("/v1/auth/register").set("Content-Type", "application/json").send("{oops");
    const huge = await request(app)
      .post("/v1/auth/register")
      .send({ email: "a@example.com", password: TEST_PASSWORD, displayName: "x".repeat(20_000) });

    expect([malformed.status, malformed.body.error.code]).toEqual([400, "invalid_json"]);
    expect([huge.status, huge.body.error.code]).toEqual([413, "payload_too_large"]);
  });
});

describe("login", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("signs in with the right password and records when", async () => {
    const user = await register(app);

    const res = await request(app).post("/v1/auth/login").send({ email: user.email.toUpperCase(), password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: user.userId, email: user.email, displayName: "Test User" });
    const me = await request(app).get("/v1/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).lastLoginAt).toBeInstanceOf(Date);
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    const user = await register(app);

    const wrongPassword = await request(app).post("/v1/auth/login").send({ email: user.email, password: "not the password" });
    const unknownEmail = await request(app).post("/v1/auth/login").send({ email: "nobody@example.com", password: "not the password" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(withoutRequestId(unknownEmail.body)).toEqual(withoutRequestId(wrongPassword.body));
    expect(wrongPassword.body.error.code).toBe("invalid_credentials");
  });

  it("does not sign in as the sample recipient, which has no password", async () => {
    await register(app);
    const recipient = await prisma.user.findFirstOrThrow({ where: { email: null } });
    await prisma.user.update({ where: { id: recipient.id }, data: { email: "recipient@example.com" } });

    const res = await request(app).post("/v1/auth/login").send({ email: "recipient@example.com", password: "anything at all" });

    expect(res.status).toBe(401);
  });
});

describe("GET /v1/me and the access token", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("returns the signed-in user, the sandbox and when the session ends", async () => {
    const user = await register(app);

    const res = await request(app).get("/v1/me").set(bearer(user));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: user.userId, email: user.email, displayName: "Test User" },
      sandbox: { kind: "REGISTERED", expiresAt: null },
      session: { expiresAt: expect.any(String) },
    });
  });

  it("refuses a missing token, a malformed header and a forged token, all with the same answer", async () => {
    const user = await register(app);
    const forged = `${user.token.slice(0, -4)}AAAA`;

    const answers = await Promise.all([
      request(app).get("/v1/me"),
      request(app).get("/v1/me").set("Authorization", user.token),
      request(app).get("/v1/me").set("Authorization", `Basic ${user.token}`),
      request(app).get("/v1/me").set("Authorization", `Bearer ${forged}`),
    ]);

    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      expect(withoutRequestId(res.body)).toEqual(withoutRequestId(answers[0]!.body));
    }
  });

  it("refuses a token after it expires", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const clocked = createTestApp({ now: () => now });
    const user = await register(clocked);

    now = new Date("2026-01-01T01:59:59Z");
    expect((await request(clocked).get("/v1/me").set(bearer(user))).status).toBe(200);
    now = new Date("2026-01-01T02:00:01Z");
    expect((await request(clocked).get("/v1/me").set(bearer(user))).status).toBe(401);
  });

  it("refuses a valid token as soon as the sandbox expires, and one whose user is gone", async () => {
    const user = await register(app);
    const { sandboxId } = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

    await prisma.sandbox.update({ where: { id: sandboxId }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    expect((await request(app).get("/v1/me").set(bearer(user))).status).toBe(200);
    await prisma.sandbox.update({ where: { id: sandboxId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get("/v1/me").set(bearer(user))).status).toBe(401);

    await resetDb();
    expect((await request(app).get("/v1/me").set(bearer(user))).status).toBe(401);
  });
});

describe("rate limits", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("limits login attempts per email, the right password included, and says when to retry", async () => {
    let now = new Date("2026-01-01T00:00:10Z");
    const limited = createTestApp({
      now: () => now,
      authRateLimits: { ...relaxedRateLimits, loginPerEmail: { limit: 3, windowSeconds: 900 } },
    });
    const user = await register(limited);
    const other = await register(limited);
    const attempt = (email: string, password: string) => request(limited).post("/v1/auth/login").send({ email, password });

    for (let index = 0; index < 3; index += 1) {
      expect((await attempt(user.email, "wrong password")).status).toBe(401);
    }
    const blocked = await attempt(user.email, TEST_PASSWORD);

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
    expect(blocked.headers["retry-after"]).toBe("890");
    // The same email in another case is the same email.
    expect((await attempt(user.email.toUpperCase(), TEST_PASSWORD)).status).toBe(429);
    expect((await attempt(other.email, TEST_PASSWORD)).status).toBe(200);

    now = new Date("2026-01-01T00:15:00Z");
    expect((await attempt(user.email, TEST_PASSWORD)).status).toBe(200);
  });

  it("limits login attempts per address across different emails", async () => {
    const limited = createTestApp({
      authRateLimits: { ...relaxedRateLimits, loginPerIp: { limit: 2, windowSeconds: 300 } },
    });
    const attempt = (email: string) => request(limited).post("/v1/auth/login").send({ email, password: "whatever password" });

    expect((await attempt("a@example.com")).status).toBe(401);
    expect((await attempt("b@example.com")).status).toBe(401);
    const blocked = await attempt("c@example.com");

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits registrations per address", async () => {
    const limited = createTestApp({
      authRateLimits: { ...relaxedRateLimits, registerPerIp: { limit: 2, windowSeconds: 3600 } },
    });
    await register(limited);
    await register(limited);

    const blocked = await request(limited)
      .post("/v1/auth/register")
      .send({ email: "third@example.com", password: TEST_PASSWORD, displayName: "Third" });

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(await prisma.user.findUnique({ where: { email: "third@example.com" } })).toBeNull();
  });

  it("stores neither the address nor the email in the counters", async () => {
    await register(app, { email: "private@example.com" });
    await request(app).post("/v1/auth/login").send({ email: "private@example.com", password: TEST_PASSWORD });

    const keys = (await prisma.rateLimitHit.findMany()).map((hit) => hit.key).join(" ");
    expect(keys).toContain("login:email:");
    expect(keys).not.toContain("private@example.com");
    expect(keys).not.toMatch(/127\.0\.0\.1|::1/);
  });
});

describe("credentials and logs", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("never writes a password or an access token to the log, on success or on failure", async () => {
    const { lines, logger } = captureLogs();
    const logged = createTestApp({ logger });
    const password = "a very distinctive password 4821";

    const user = await register(logged, { password });
    const login = await request(logged).post("/v1/auth/login").send({ email: user.email, password });
    await request(logged).post("/v1/auth/login").send({ email: user.email, password: "a wrong distinctive password 7733" });
    await request(logged).get("/v1/me").set(bearer(user));
    await request(logged).get("/v1/me").set("Authorization", "Bearer forged.distinctive.token");
    await request(logged).post("/v1/auth/register").send({ email: "bad", password: "short-secret-9" });

    const output = lines.join("");
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(output).toContain("/v1/auth/login");
    for (const secret of [
      password,
      "a wrong distinctive password 7733",
      "short-secret-9",
      user.token,
      login.body.accessToken,
      "forged.distinctive.token",
    ]) {
      expect(output).not.toContain(secret);
    }
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(output).not.toContain(stored.passwordHash);
  });
});
