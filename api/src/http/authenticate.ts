import type { Request } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { JwtTokens } from "../infra/security/jwt-tokens.js";
import { HttpError } from "./errors.js";
import type { AuthenticatedUser } from "./route.js";

// One answer for every way authentication can fail, so a response does not tell a missing
// token from a forged one, an expired one, or one whose user is gone.
function unauthorized(): HttpError {
  return new HttpError(401, "unauthorized", "Authentication required", {
    headers: { "WWW-Authenticate": "Bearer" },
  });
}

export function createAuthenticator(deps: { prisma: PrismaClient; tokens: JwtTokens; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  return async function authenticate(request: Request): Promise<AuthenticatedUser> {
    const [scheme, token] = (request.get("authorization") ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw unauthorized();
    }
    const verified = await deps.tokens.verify(token);
    if (!verified) {
      throw unauthorized();
    }
    // The token proves who signed in; the database says whether that user still exists and
    // whether its sandbox is still alive. Expiry takes effect at once, not at the next cleanup.
    const user = await deps.prisma.user.findUnique({
      where: { id: verified.userId },
      select: { id: true, sandboxId: true, sandbox: { select: { expiresAt: true } } },
    });
    if (!user || (user.sandbox.expiresAt !== null && user.sandbox.expiresAt <= now())) {
      throw unauthorized();
    }
    return { id: user.id, sandboxId: user.sandboxId, sessionExpiresAt: verified.expiresAt };
  };
}
