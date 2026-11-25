import { setTimeout as sleep } from "node:timers/promises";
import { transferMoney } from "../application/transfer-money.js";
import { prisma } from "../db/prisma.js";
import { createPessimisticLedger } from "../infra/db/pessimistic-ledger.js";

// Smoke check for a running stack: post one transfer and wait until the delivery process
// has delivered its event and the receiver has recorded it. Exits non-zero otherwise.
const TIMEOUT_MS = 30_000;

async function main() {
  const sandbox = await prisma.sandbox.create({ data: { kind: "DEMO" } });
  const user = await prisma.user.create({ data: { sandboxId: sandbox.id, displayName: "Smoke check" } });
  const account = await prisma.account.create({
    data: { name: "Smoke check", currency: "BRL", userId: user.id, sandboxId: sandbox.id },
  });
  const system = await prisma.account.findFirstOrThrow({ where: { kind: "SYSTEM", currency: "BRL" } });

  const { transferId } = await transferMoney(createPessimisticLedger(prisma), {
    actor: { type: "system" },
    fromAccountId: system.id,
    toAccountId: account.id,
    amount: 100n,
    idempotencyKey: `smoke:${account.id}`,
  });

  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { transferId } });
    const receipt = await prisma.webhookReceipt.findUnique({ where: { eventId: event.id } });
    if (event.status === "DELIVERED" && receipt) {
      console.log(
        JSON.stringify({ result: "delivered", eventId: event.id, attempts: event.attempts, deliveries: receipt.deliveries }),
      );
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Event ${event.id} not delivered in ${TIMEOUT_MS} ms: status ${event.status}, last error ${event.lastError}`);
    }
    await sleep(250);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
