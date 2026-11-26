import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { expect } from "vitest";
import { prisma } from "../db/prisma.js";
import { bearer, postTransfer, type Wallet } from "./api.js";
import { balanceOf } from "./fixtures.js";

// What the owner has by the time a scenario runs.
export type World = {
  app: Express;
  owner: Wallet & { transferId: string; eventIds: string[]; sandboxId: string };
  intruder: Wallet & { sandboxId: string };
};

export type AuthorizationCase = {
  // `<method> <path>` exactly as the application registers it.
  route: string;
  proves: string;
  run(world: World): Promise<void>;
};

const errorOf = (response: request.Response) => ({ ...response.body.error, requestId: undefined });

// Someone else's resource must be indistinguishable from one that does not exist.
async function expectSameAsMissing(theirs: request.Response, missing: request.Response) {
  expect(theirs.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(errorOf(theirs)).toEqual(errorOf(missing));
}

// Every route of /v1 that requires a signed-in user, with a proof that one user cannot
// read or move what belongs to another. A route missing from this list fails the suite.
export const authorizationMatrix: AuthorizationCase[] = [
  {
    route: "get /v1/me",
    proves: "a token only ever describes its own user",
    async run({ app, owner, intruder }) {
      const res = await request(app).get("/v1/me").set(bearer(intruder));
      expect(res.body.user.id).toBe(intruder.userId);
      expect(JSON.stringify(res.body)).not.toContain(owner.userId);
    },
  },
  {
    route: "get /v1/accounts",
    proves: "the list holds only the caller's accounts",
    async run({ app, owner, intruder }) {
      const res = await request(app).get("/v1/accounts").set(bearer(intruder));
      expect(res.body.accounts.map((account: { id: string }) => account.id)).toEqual([intruder.accountId]);
      expect(JSON.stringify(res.body)).not.toContain(owner.accountId);
    },
  },
  {
    route: "post /v1/accounts",
    proves: "an account is opened for the caller, whatever owner the body names",
    async run({ app, owner, intruder }) {
      const res = await request(app)
        .post("/v1/accounts")
        .set(bearer(intruder))
        .send({ name: "Planted", currency: "BRL", userId: owner.userId, sandboxId: owner.sandboxId });
      expect(res.status).toBe(201);
      const created = await prisma.account.findUniqueOrThrow({ where: { id: res.body.id } });
      expect([created.userId, created.sandboxId]).toEqual([intruder.userId, intruder.sandboxId]);
      expect(await prisma.account.count({ where: { userId: owner.userId } })).toBe(1);
    },
  },
  {
    route: "get /v1/accounts/{id}",
    proves: "another user's account, and another user's recipient, look like accounts that do not exist",
    async run({ app, owner, intruder }) {
      const missing = await request(app).get(`/v1/accounts/${randomUUID()}`).set(bearer(intruder));
      for (const id of [owner.accountId, owner.recipientAccountId]) {
        await expectSameAsMissing(await request(app).get(`/v1/accounts/${id}`).set(bearer(intruder)), missing);
      }
    },
  },
  {
    route: "get /v1/accounts/{id}/entries",
    proves: "another user's statement looks like the statement of an account that does not exist",
    async run({ app, owner, intruder }) {
      const missing = await request(app).get(`/v1/accounts/${randomUUID()}/entries`).set(bearer(intruder));
      const theirs = await request(app).get(`/v1/accounts/${owner.accountId}/entries`).set(bearer(intruder));
      await expectSameAsMissing(theirs, missing);
    },
  },
  {
    route: "get /v1/recipients",
    proves: "recipients come from the caller's sandbox only",
    async run({ app, owner, intruder }) {
      const res = await request(app).get("/v1/recipients").set(bearer(intruder));
      expect(res.body.recipients.map((recipient: { accountId: string }) => recipient.accountId)).toEqual([
        intruder.recipientAccountId,
      ]);
      expect(JSON.stringify(res.body)).not.toContain(owner.accountId);
    },
  },
  {
    route: "post /v1/transfers",
    proves: "a user cannot debit another user's account nor pay into another sandbox, and no money moves",
    async run({ app, owner, intruder }) {
      const balances = async () => [await balanceOf(owner.accountId), await balanceOf(intruder.accountId)];
      const before = await balances();
      const transfers = await prisma.transfer.count();
      const missing = await postTransfer(app, intruder, {
        fromAccountId: intruder.accountId,
        toAccountId: randomUUID(),
        amount: "100",
      });

      const attempts = [
        // Debit the owner's account, to the intruder's and to the owner's own recipient.
        { fromAccountId: owner.accountId, toAccountId: intruder.accountId },
        { fromAccountId: owner.accountId, toAccountId: owner.recipientAccountId },
        // Pay into another sandbox.
        { fromAccountId: intruder.accountId, toAccountId: owner.accountId },
        { fromAccountId: intruder.accountId, toAccountId: owner.recipientAccountId },
      ];
      for (const attempt of attempts) {
        await expectSameAsMissing(await postTransfer(app, intruder, { ...attempt, amount: "100" }), missing);
      }

      expect(await balances()).toEqual(before);
      expect(await prisma.transfer.count()).toBe(transfers);
    },
  },
  {
    route: "get /v1/transfers/{id}",
    proves: "another user's transfer looks like a transfer that does not exist",
    async run({ app, owner, intruder }) {
      const missing = await request(app).get(`/v1/transfers/${randomUUID()}`).set(bearer(intruder));
      const theirs = await request(app).get(`/v1/transfers/${owner.transferId}`).set(bearer(intruder));
      await expectSameAsMissing(theirs, missing);
    },
  },
  {
    route: "get /v1/webhook-events",
    proves: "the list holds only the events of the caller's sandbox",
    async run({ app, owner, intruder }) {
      const res = await request(app).get("/v1/webhook-events").set(bearer(intruder));
      const ids: string[] = res.body.events.map((event: { id: string }) => event.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.filter((id) => owner.eventIds.includes(id))).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(owner.transferId);
    },
  },
  {
    route: "post /v1/webhook-receiver/failures",
    proves: "a user controls the receiver failures of its own sandbox only",
    async run({ app, owner, intruder }) {
      const res = await request(app)
        .post("/v1/webhook-receiver/failures")
        .set(bearer(intruder))
        .send({ failures: 3, sandboxId: owner.sandboxId });
      expect(res.status).toBe(200);
      const failuresOf = async (id: string) =>
        (await prisma.sandbox.findUniqueOrThrow({ where: { id } })).receiverFailuresLeft;
      expect(await failuresOf(owner.sandboxId)).toBe(0);
      expect(await failuresOf(intruder.sandboxId)).toBe(3);
    },
  },
];

// Routes of /v1 that take no signed-in user. Everything else must be in the matrix.
export const publicV1Routes = ["post /v1/auth/register", "post /v1/auth/login"];
