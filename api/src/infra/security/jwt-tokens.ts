import { jwtVerify, SignJWT } from "jose";
import type { AccessTokens } from "../../application/identity.js";

const ISSUER = "wallety";
const AUDIENCE = "wallety-api";
const ALGORITHM = "HS256";

export type VerifiedToken = { userId: string; expiresAt: Date };

export type JwtTokens = AccessTokens & {
  // Null for anything that is not a valid, unexpired token issued by this service.
  verify(token: string): Promise<VerifiedToken | null>;
};

export function createJwtTokens(options: { secret: string; ttlSeconds: number; now?: () => Date }): JwtTokens {
  const key = new TextEncoder().encode(options.secret);
  const now = options.now ?? (() => new Date());

  return {
    async issue(userId, issueOptions = {}) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const expiresAt = issueOptions.expiresAt
        ? Math.floor(issueOptions.expiresAt.getTime() / 1000)
        : issuedAt + options.ttlSeconds;
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(key);
      return { token, expiresAt: new Date(expiresAt * 1000) };
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          // Pinned: a token cannot choose a weaker algorithm, or none.
          algorithms: [ALGORITHM],
          currentDate: now(),
        });
        if (!payload.sub || !payload.exp) {
          return null;
        }
        return { userId: payload.sub, expiresAt: new Date(payload.exp * 1000) };
      } catch {
        return null;
      }
    },
  };
}
