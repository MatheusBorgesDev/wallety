import { createHash } from "node:crypto";
import { z } from "zod";
import { DemoCapacityReached, EmailAlreadyRegistered, InvalidCredentials } from "../../application/errors.js";
import type { AccessToken, AccessTokens, PasswordHasher, UserDirectory, Workspace } from "../../application/identity.js";
import { normalizeEmail } from "../../application/identity.js";
import { login } from "../../application/login.js";
import { registerUser } from "../../application/register-user.js";
import { startDemo, type DemoPolicy } from "../../application/start-demo.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { HttpError } from "../../http/errors.js";
import { defineRoute, type AnyRoute } from "../../http/route.js";

export type RateLimit = { limit: number; windowSeconds: number };

export type AuthRateLimits = {
  demoPerIp: RateLimit;
  registerPerIp: RateLimit;
  loginPerIp: RateLimit;
  loginPerEmail: RateLimit;
};

export const defaultAuthRateLimits: AuthRateLimits = {
  demoPerIp: { limit: 5, windowSeconds: 3600 },
  registerPerIp: { limit: 5, windowSeconds: 3600 },
  loginPerIp: { limit: 20, windowSeconds: 300 },
  loginPerEmail: { limit: 5, windowSeconds: 900 },
};

type AuthDependencies = {
  prisma: PrismaClient;
  workspace: Workspace;
  directory: UserDirectory;
  hasher: PasswordHasher;
  tokens: AccessTokens;
  rateLimits: AuthRateLimits;
  demoPolicy: DemoPolicy;
  // Removes a few expired sandboxes. Absent where no cleanup login is configured.
  purgeSome?: () => Promise<unknown>;
  now: () => Date;
};

const emailSchema = z.email().max(254);
// The upper bound keeps a request from making the server hash an arbitrarily long input.
const passwordSchema = z.string().min(10).max(128).describe("10 to 128 characters");

const userSchema = z
  .object({ id: z.uuid(), email: z.email().nullable(), displayName: z.string() })
  .meta({ id: "User" });

const sessionSchema = z
  .object({
    user: userSchema,
    accessToken: z.string().describe("Send it as `Authorization: Bearer <token>`"),
    tokenType: z.literal("Bearer"),
    expiresAt: z.iso.datetime().describe("When the access token stops being accepted"),
  })
  .meta({ id: "Session" });

function session(user: z.infer<typeof userSchema>, accessToken: AccessToken): z.infer<typeof sessionSchema> {
  return {
    user,
    accessToken: accessToken.token,
    tokenType: "Bearer",
    expiresAt: accessToken.expiresAt.toISOString(),
  };
}

// Rate-limit keys never hold the address or the email themselves.
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

export function authRoutes(deps: AuthDependencies): AnyRoute[] {
  const { rateLimits } = deps;

  return [
    defineRoute({
      method: "post",
      path: "/v1/auth/register",
      tag: "Auth",
      summary: "Create a user",
      description:
        "Creates the user inside a sandbox of its own, with a funded account and a sample recipient to transfer " +
        "to. The opening balance is a regular transfer out of the system account.",
      access: "public",
      request: {
        body: z.object({
          email: emailSchema,
          password: passwordSchema,
          displayName: z.string().trim().min(1).max(80),
        }),
      },
      rateLimit: ({ ip }) => [{ key: `register:ip:${fingerprint(ip)}`, ...rateLimits.registerPerIp }],
      responses: {
        201: { description: "The user was created and is signed in", schema: sessionSchema },
        409: { description: "The email is already registered" },
      },
      handler: async ({ body }) => {
        try {
          const registered = await registerUser(deps, body);
          return { status: 201, body: session(registered.user, registered.accessToken) };
        } catch (error) {
          if (error instanceof EmailAlreadyRegistered) {
            throw new HttpError(409, "email_already_registered", error.message);
          }
          throw error;
        }
      },
    }),

    defineRoute({
      method: "post",
      path: "/v1/auth/demo",
      tag: "Auth",
      summary: "Start a demo: no sign-up, removed after 24 hours",
      description:
        "Creates a throwaway user in a sandbox of its own, with a funded account and a sample recipient, and " +
        "signs it in. The token lasts as long as the sandbox. After 24 hours the token is refused at once and " +
        "the sandbox is removed with everything in it.",
      access: "public",
      rateLimit: ({ ip }) => [{ key: `demo:ip:${fingerprint(ip)}`, ...rateLimits.demoPerIp }],
      responses: {
        201: {
          description: "The demo user was created and is signed in",
          schema: sessionSchema.extend({ sandboxExpiresAt: z.iso.datetime() }).meta({ id: "DemoSession" }),
        },
        503: { description: "Too many demos are running; try again later", headers: { "Retry-After": "Seconds to wait" } },
      },
      handler: async ({ log }) => {
        // Every new demo first makes room by removing some expired ones.
        await deps.purgeSome?.().catch((error: unknown) => log.warn({ err: error }, "Opportunistic cleanup failed"));
        try {
          const demo = await startDemo({
            workspace: deps.workspace,
            tokens: deps.tokens,
            countDemoSandboxes: () => deps.prisma.sandbox.count({ where: { kind: "DEMO" } }),
            policy: deps.demoPolicy,
            now: deps.now,
          });
          return {
            status: 201,
            body: { ...session(demo.user, demo.accessToken), sandboxExpiresAt: demo.sandboxExpiresAt.toISOString() },
          };
        } catch (error) {
          if (error instanceof DemoCapacityReached) {
            throw new HttpError(503, "demo_capacity_reached", error.message, { headers: { "Retry-After": "600" } });
          }
          throw error;
        }
      },
    }),

    defineRoute({
      method: "post",
      path: "/v1/auth/login",
      tag: "Auth",
      summary: "Sign in",
      description: "An unknown email and a wrong password get the same answer.",
      access: "public",
      // No password rules here: a password that predates a rule change must still sign in.
      request: { body: z.object({ email: emailSchema, password: z.string().min(1).max(128) }) },
      rateLimit: ({ ip, body }) => [
        { key: `login:ip:${fingerprint(ip)}`, ...rateLimits.loginPerIp },
        { key: `login:email:${fingerprint(normalizeEmail(body.email))}`, ...rateLimits.loginPerEmail },
      ],
      responses: {
        200: { description: "Signed in", schema: sessionSchema },
        401: { description: "Invalid email or password" },
      },
      handler: async ({ body }) => {
        try {
          const { userId, accessToken } = await login(deps, body);
          const user = await deps.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: { id: true, email: true, displayName: true },
          });
          return { status: 200, body: session(user, accessToken) };
        } catch (error) {
          if (error instanceof InvalidCredentials) {
            throw new HttpError(401, "invalid_credentials", error.message);
          }
          throw error;
        }
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/me",
      tag: "Auth",
      summary: "The signed-in user and how long the session lasts",
      access: "user",
      responses: {
        200: {
          description: "The signed-in user",
          schema: z.object({
            user: userSchema,
            sandbox: z.object({
              kind: z.enum(["DEMO", "REGISTERED"]),
              expiresAt: z.iso.datetime().nullable().describe("When the sandbox and everything in it is removed"),
            }),
            session: z.object({ expiresAt: z.iso.datetime() }),
          }),
        },
      },
      handler: async ({ user }) => {
        const found = await deps.prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: {
            id: true,
            email: true,
            displayName: true,
            sandbox: { select: { kind: true, expiresAt: true } },
          },
        });
        return {
          status: 200,
          body: {
            user: { id: found.id, email: found.email, displayName: found.displayName },
            sandbox: { kind: found.sandbox.kind, expiresAt: found.sandbox.expiresAt?.toISOString() ?? null },
            session: { expiresAt: user.sessionExpiresAt.toISOString() },
          },
        };
      },
    }),
  ];
}
