import type { DeliveryOutcome, Transport } from "../../webhooks/dispatcher.js";

// Delivers over HTTP. A delivery succeeds only on a 2xx answer. Redirects are not
// followed and the response body is never read.
export function createHttpTransport(options: { timeoutMs?: number } = {}): Transport {
  const timeoutMs = options.timeoutMs ?? 5000;
  return {
    async send(request): Promise<DeliveryOutcome> {
      try {
        const response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        return { ok: false, error: name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : `network error (${name})` };
      }
    },
  };
}
