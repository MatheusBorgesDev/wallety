import { InvalidCredentials } from "./errors.js";
import {
  normalizeEmail,
  type AccessToken,
  type AccessTokens,
  type PasswordHasher,
  type UserDirectory,
} from "./identity.js";

export async function login(
  deps: { directory: UserDirectory; hasher: PasswordHasher; tokens: AccessTokens; now?: () => Date },
  input: { email: string; password: string },
): Promise<{ userId: string; accessToken: AccessToken }> {
  const credentials = await deps.directory.findCredentialsByEmail(normalizeEmail(input.email));
  // Always verify, even when there is nothing to verify against: an unknown email and a
  // wrong password take the same time and fail with the same error.
  const passwordMatches = await deps.hasher.verify(credentials?.passwordHash ?? null, input.password);
  if (!credentials || !passwordMatches) {
    throw new InvalidCredentials();
  }
  await deps.directory.recordLogin(credentials.userId, (deps.now ?? (() => new Date()))());
  return { userId: credentials.userId, accessToken: await deps.tokens.issue(credentials.userId) };
}
