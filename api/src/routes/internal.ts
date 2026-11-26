import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Purger } from "../infra/db/purge.js";
import { HttpError } from "../http/errors.js";
import { defineRoute, type AnyRoute } from "../http/route.js";

// Compared as digests: equal length whatever was sent, and in constant time, so the
// answer does not leak how much of the secret a guess got right.
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// Operational routes: protected by a shared secret, called by a scheduler, and left out
// of the public API document.
export function internalRoutes(deps: { purger: Purger; purgeSecret: string; now: () => Date }): AnyRoute[] {
  return [
    defineRoute({
      method: "post",
      path: "/internal/purge",
      tag: "Internal",
      summary: "Remove expired sandboxes",
      access: "public",
      documented: false,
      request: { headers: z.object({ authorization: z.string().optional() }) },
      responses: { 200: { description: "What was removed" } },
      handler: async ({ headers }) => {
        const [scheme, secret] = (headers.authorization ?? "").split(" ");
        // Checked before anything else happens: without the secret, no query runs.
        if (scheme !== "Bearer" || !secret || !sameSecret(secret, deps.purgeSecret)) {
          throw new HttpError(401, "unauthorized", "Authentication required");
        }
        return { status: 200, body: await deps.purger.purge({ now: deps.now(), maxSandboxes: 200 }) };
      },
    }),
  ];
}
