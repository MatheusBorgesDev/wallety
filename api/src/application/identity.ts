import type { LedgerTransaction } from "./ledger.js";

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  // With a null hash it still does the work of a verification and answers false, so
  // checking an unknown email takes as long as checking a wrong password.
  verify(hash: string | null, password: string): Promise<boolean>;
};

export type AccessToken = { token: string; expiresAt: Date };

export type AccessTokens = {
  issue(userId: string): Promise<AccessToken>;
};

export type SandboxKind = "DEMO" | "REGISTERED";

export type NewUser = {
  sandboxId: string;
  // Null for a user that cannot log in.
  email: string | null;
  passwordHash: string | null;
  displayName: string;
};

export type IdentityTransaction = {
  createSandbox(input: { kind: SandboxKind; expiresAt: Date | null }): Promise<{ id: string }>;
  // Throws EmailAlreadyRegistered when the email is taken.
  createUser(user: NewUser): Promise<{ id: string }>;
  createAccount(input: { userId: string; sandboxId: string; name: string; currency: string }): Promise<{ id: string }>;
  systemAccountId(currency: string): Promise<string>;
};

// One atomic unit of work over identities and the ledger together.
export type Workspace = {
  transaction<T>(work: (tx: { identity: IdentityTransaction; ledger: LedgerTransaction }) => Promise<T>): Promise<T>;
};

export type UserDirectory = {
  findCredentialsByEmail(email: string): Promise<{ userId: string; passwordHash: string | null } | null>;
  recordLogin(userId: string, at: Date): Promise<void>;
};

// Emails are compared case-insensitively and stored in one form.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
