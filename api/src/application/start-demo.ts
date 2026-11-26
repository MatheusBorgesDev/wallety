import { DemoCapacityReached } from "./errors.js";
import type { AccessToken, AccessTokens, Workspace } from "./identity.js";
import { provisionSandbox } from "./provision-sandbox.js";

export const DEMO_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type DemoPolicy = {
  // Demo sandboxes the deployment keeps at once, expired ones not yet removed included.
  maxDemoSandboxes: number;
};

export type DemoSession = {
  user: { id: string; email: null; displayName: string };
  accessToken: AccessToken;
  // When the sandbox, and everything in it, stops being reachable and is due for removal.
  sandboxExpiresAt: Date;
};

// A visitor gets a user that exists for a day: a sandbox of its own, a funded account and
// someone to pay, with no password and no way back in once the token is gone.
export async function startDemo(deps: {
  workspace: Workspace;
  tokens: AccessTokens;
  countDemoSandboxes: () => Promise<number>;
  policy: DemoPolicy;
  now: () => Date;
}): Promise<DemoSession> {
  if ((await deps.countDemoSandboxes()) >= deps.policy.maxDemoSandboxes) {
    throw new DemoCapacityReached();
  }
  const sandboxExpiresAt = new Date(deps.now().getTime() + DEMO_LIFETIME_MS);
  const displayName = "Demo user";

  const { owner } = await deps.workspace.transaction((tx) =>
    provisionSandbox(tx, {
      kind: "DEMO",
      expiresAt: sandboxExpiresAt,
      owner: { email: null, passwordHash: null, displayName },
    }),
  );

  return {
    user: { id: owner.userId, email: null, displayName },
    // The token lasts exactly as long as the sandbox: a demo user cannot sign in again.
    accessToken: await deps.tokens.issue(owner.userId, { expiresAt: sandboxExpiresAt }),
    sandboxExpiresAt,
  };
}
