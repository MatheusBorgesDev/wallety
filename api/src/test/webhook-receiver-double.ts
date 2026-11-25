import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ReceivedDelivery = {
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

// A stand-in for a webhook receiver: a real HTTP server on a local port whose
// answers are scripted by the test.
export async function startReceiverDouble() {
  const deliveries: ReceivedDelivery[] = [];
  let statuses: number[] = [];
  let hang = false;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (hang) {
        return; // never answer: the caller must time out
      }
      response.statusCode = statuses.shift() ?? 200;
      if (response.statusCode >= 300 && response.statusCode < 400) {
        // A real redirect: a client that follows it shows up here as a second delivery.
        response.setHeader("Location", "/redirected");
      }
      response.end("ignored");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    deliveries,
    // Status codes for the next deliveries, in order. After they run out, 200.
    respondWith(...next: number[]) {
      statuses = next;
    },
    neverAnswer() {
      hang = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
