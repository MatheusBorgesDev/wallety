import argon2 from "argon2";
import type { PasswordHasher } from "../../application/identity.js";

// Argon2id with 19 MiB of memory, 2 passes and 1 lane: the minimum configuration the
// OWASP Password Storage Cheat Sheet recommends for Argon2id. The parameters are stored
// inside each hash, so they can be raised later without invalidating existing passwords.
export const argon2Parameters = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function createArgon2Hasher(): PasswordHasher {
  // Verified against when there is no real hash, so that the answer takes as long.
  let decoy: Promise<string> | undefined;

  return {
    hash: (password) => argon2.hash(password, argon2Parameters),
    async verify(hash, password) {
      if (hash === null) {
        decoy ??= argon2.hash("decoy password, matches nothing", argon2Parameters);
        await argon2.verify(await decoy, password);
        return false;
      }
      return argon2.verify(hash, password);
    },
  };
}
