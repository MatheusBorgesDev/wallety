import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

describe("HTTP surface", () => {
  it("answers an unknown route with the common error shape and the request id", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "not_found", message: "Not found", requestId: res.headers["x-request-id"] },
    });
  });

  it("sets security headers and does not advertise the framework", async () => {
    const res = await request(app).get("/health/live");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("sends no CORS header when no origin is configured", async () => {
    const res = await request(app).get("/health/live").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows only the configured origin", async () => {
    process.env.CORS_ORIGINS = "https://app.example";
    try {
      const restricted = createApp();
      const allowed = await request(restricted).get("/health/live").set("Origin", "https://app.example");
      const refused = await request(restricted).get("/health/live").set("Origin", "https://evil.example");
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example");
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      delete process.env.CORS_ORIGINS;
    }
  });

  it("serves Swagger UI without inline scripts, so the default CSP holds", async () => {
    const page = await request(app).get("/docs");
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/<script>(?!<\/script>)/);
    expect(page.text).toContain('src="/docs/initializer.js"');

    for (const asset of ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "initializer.js"]) {
      expect((await request(app).get(`/docs/${asset}`)).status).toBe(200);
    }
  });

  it("serves no other file of the Swagger UI package", async () => {
    expect((await request(app).get("/docs/package.json")).status).toBe(404);
    expect((await request(app).get("/docs/..%2Fpackage.json")).status).toBe(404);
  });
});
