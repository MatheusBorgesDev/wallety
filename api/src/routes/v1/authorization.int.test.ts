import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "../../db/prisma.js";
import { listRegisteredRoutes } from "../../http/route-inventory.js";
import { createTestApp, postTransfer, registerWithWallet } from "../../test/api.js";
import { authorizationMatrix, publicV1Routes, type World } from "../../test/authorization-matrix.js";
import { resetDb, disconnectDb } from "../../test/db.js";

const app = createTestApp();

async function buildWorld(): Promise<World> {
  const owner = await registerWithWallet(app);
  const intruder = await registerWithWallet(app);
  const transfer = await postTransfer(app, owner, {
    fromAccountId: owner.accountId,
    toAccountId: owner.recipientAccountId,
    amount: "1234",
  });
  const sandboxOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).sandboxId;
  const ownerSandboxId = await sandboxOf(owner.userId);
  const events = await prisma.outboxEvent.findMany({ where: { sandboxId: ownerSandboxId }, select: { id: true } });
  return {
    app,
    owner: { ...owner, transferId: transfer.body.id, eventIds: events.map((event) => event.id), sandboxId: ownerSandboxId },
    intruder: { ...intruder, sandboxId: await sandboxOf(intruder.userId) },
  };
}

describe("authorization: one user cannot read or move what belongs to another", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it.each(authorizationMatrix)("$route: $proves", async (authorizationCase) => {
    await authorizationCase.run(await buildWorld());
  });

  it.each(authorizationMatrix)("$route refuses a request without a token", async ({ route }) => {
    const [method, path] = route.split(" ") as ["get" | "post", string];
    const res = await request(app)[method](path.replace(/\{\w+\}/g, "00000000-0000-4000-8000-000000000000"));
    expect(res.status).toBe(401);
  });
});

describe("authorization matrix coverage", () => {
  afterAll(disconnectDb);

  it("covers every /v1 route the application answers, except the ones declared public", () => {
    const registered = listRegisteredRoutes(app)
      .map(({ method, path }) => `${method} ${path}`)
      .filter((route) => route.split(" ")[1]!.startsWith("/v1/"));
    expect(registered.length).toBeGreaterThan(publicV1Routes.length);

    const covered = new Set([...authorizationMatrix.map((entry) => entry.route), ...publicV1Routes]);

    expect(registered.filter((route) => !covered.has(route))).toEqual([]);
  });

  it("has no entry for a route that does not exist", () => {
    const registered = new Set(listRegisteredRoutes(app).map(({ method, path }) => `${method} ${path}`));
    const stale = [...authorizationMatrix.map((entry) => entry.route), ...publicV1Routes].filter(
      (route) => !registered.has(route),
    );
    expect(stale).toEqual([]);
  });

  it("keeps the routes declared public really public, and only those", async () => {
    for (const route of publicV1Routes) {
      const [method, path] = route.split(" ") as ["post", string];
      // No token, and the answer is not about authentication.
      expect((await request(app)[method](path).send({})).status).not.toBe(401);
    }
  });
});
