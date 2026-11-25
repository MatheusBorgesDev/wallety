import { describe, it, expect } from "vitest";
import request from "supertest";
import { Writable } from "node:stream";
import { createApp } from "../app.js";
import { createLogger } from "./logger.js";

function captureLogs() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, destination };
}

describe("request logging", () => {
  it("writes one structured line per request with route, status and duration", async () => {
    const { lines, destination } = captureLogs();
    const app = createApp({ logger: createLogger({ level: "info", destination }) });

    await request(app).get("/health/live");

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.severity).toBe("INFO");
    expect(entry.req).toMatchObject({ method: "GET", url: "/health/live" });
    expect(entry.res).toEqual({ statusCode: 200 });
    expect(typeof entry.responseTime).toBe("number");
    expect(typeof entry.req.id).toBe("string");
  });

  it("never logs credentials sent in headers", async () => {
    const { lines, destination } = captureLogs();
    const app = createApp({ logger: createLogger({ level: "info", destination }) });

    await request(app)
      .get("/health/live")
      .set("Authorization", "Bearer secret-token-123")
      .set("Cookie", "session=secret-cookie-456");

    const output = lines.join("");
    expect(output).toContain("/health/live");
    expect(output).not.toContain("secret-token-123");
    expect(output).not.toContain("secret-cookie-456");
  });

  it("echoes a correlation id and reuses a well-formed one from the client", async () => {
    const { lines, destination } = captureLogs();
    const app = createApp({ logger: createLogger({ level: "info", destination }) });

    const generated = await request(app).get("/health/live");
    const reused = await request(app).get("/health/live").set("X-Request-Id", "abc-123");
    const rejected = await request(app).get("/health/live").set("X-Request-Id", "bad id\twith spaces");

    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(reused.headers["x-request-id"]).toBe("abc-123");
    expect(rejected.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(lines[1]!).req.id).toBe("abc-123");
  });
});
