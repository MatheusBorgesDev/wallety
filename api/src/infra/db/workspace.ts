import { EmailAlreadyRegistered } from "../../application/errors.js";
import type { IdentityTransaction, UserDirectory, Workspace } from "../../application/identity.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { ledgerTransaction, type PrismaTransaction } from "./ledger-transaction.js";
import { lockBothAccounts } from "./pessimistic-ledger.js";

const UNIQUE_VIOLATION = "P2002";

function identityTransaction(tx: PrismaTransaction): IdentityTransaction {
  return {
    createSandbox: (input) => tx.sandbox.create({ data: input, select: { id: true } }),

    async createUser(user) {
      try {
        return await tx.user.create({ data: user, select: { id: true } });
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new EmailAlreadyRegistered();
        }
        throw error;
      }
    },

    createAccount: (input) => tx.account.create({ data: input, select: { id: true } }),

    async systemAccountId(currency) {
      const account = await tx.account.findFirstOrThrow({ where: { kind: "SYSTEM", currency }, select: { id: true } });
      return account.id;
    },
  };
}

// Identities and ledger in one database transaction, with the same locking as a transfer.
export function createWorkspace(prisma: PrismaClient): Workspace {
  return {
    transaction: (work) =>
      prisma.$transaction(
        (tx) => work({ identity: identityTransaction(tx), ledger: ledgerTransaction(tx, lockBothAccounts) }),
        { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 15_000 },
      ),
  };
}

export function createUserDirectory(prisma: PrismaClient): UserDirectory {
  return {
    async findCredentialsByEmail(email) {
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
      return user ? { userId: user.id, passwordHash: user.passwordHash } : null;
    },
    async recordLogin(userId, at) {
      await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
    },
  };
}
