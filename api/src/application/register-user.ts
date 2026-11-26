import { normalizeEmail, type AccessToken, type AccessTokens, type PasswordHasher, type Workspace } from "./identity.js";
import { provisionSandbox } from "./provision-sandbox.js";

export type RegisterUserInput = { email: string; password: string; displayName: string };

export type RegisteredUser = {
  user: { id: string; email: string; displayName: string };
  accessToken: AccessToken;
};

export async function registerUser(
  deps: { workspace: Workspace; hasher: PasswordHasher; tokens: AccessTokens },
  input: RegisterUserInput,
): Promise<RegisteredUser> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  // Hashing is slow on purpose; it stays outside the database transaction.
  const passwordHash = await deps.hasher.hash(input.password);

  const { owner } = await deps.workspace.transaction((tx) =>
    provisionSandbox(tx, { kind: "REGISTERED", expiresAt: null, owner: { email, passwordHash, displayName } }),
  );

  return {
    user: { id: owner.userId, email, displayName },
    accessToken: await deps.tokens.issue(owner.userId),
  };
}
