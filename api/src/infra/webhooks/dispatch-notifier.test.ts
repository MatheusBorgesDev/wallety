import { describe, it, expect } from "vitest";
import { createDispatchNotifier } from "./dispatch-notifier.js";

type Call = { url: string; method: string; headers: Record<string, string> };

function fakeFetch(answers: Record<string, { status: number; body?: string }>) {
  const calls: Call[] = [];
  const fetchDouble = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = Object.entries(answers).find(([prefix]) => url.startsWith(prefix))?.[1] ?? { status: 404 };
    return new Response(answer.body ?? "", { status: answer.status });
  }) as typeof fetch;
  return { calls, fetchDouble };
}

describe("dispatch notifier", () => {
  it("posts to the dispatch route of the delivery process", async () => {
    const { calls, fetchDouble } = fakeFetch({ "http://worker:3001": { status: 200 } });
    await createDispatchNotifier({ url: "http://worker:3001", auth: "none", fetch: fetchDouble })();
    expect(calls).toEqual([{ url: "http://worker:3001/internal/dispatch", method: "POST", headers: {} }]);
  });

  it("fails when the delivery process does not accept the notification", async () => {
    const { fetchDouble } = fakeFetch({ "http://worker:3001": { status: 403 } });
    const notify = createDispatchNotifier({ url: "http://worker:3001", auth: "none", fetch: fetchDouble });
    await expect(notify()).rejects.toThrow(/status 403/);
  });

  it("with Google identity tokens, asks the metadata server for a token for that audience and sends it", async () => {
    const { calls, fetchDouble } = fakeFetch({
      "http://metadata.test/identity": { status: 200, body: "identity-token-abc\n" },
      "https://worker.example": { status: 200 },
    });
    await createDispatchNotifier({
      url: "https://worker.example",
      auth: "google-id-token",
      fetch: fetchDouble,
      metadataUrl: "http://metadata.test/identity",
    })();
    expect(calls[0]).toEqual({
      url: "http://metadata.test/identity?audience=https%3A%2F%2Fworker.example",
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
    });
    expect(calls[1]).toEqual({
      url: "https://worker.example/internal/dispatch",
      method: "POST",
      headers: { Authorization: "Bearer identity-token-abc" },
    });
  });

  it("does not call the delivery process when it cannot get an identity token", async () => {
    const { calls, fetchDouble } = fakeFetch({ "http://metadata.test/identity": { status: 500 } });
    const notify = createDispatchNotifier({
      url: "https://worker.example",
      auth: "google-id-token",
      fetch: fetchDouble,
      metadataUrl: "http://metadata.test/identity",
    });
    await expect(notify()).rejects.toThrow(/Identity token/);
    expect(calls).toHaveLength(1);
  });
});
