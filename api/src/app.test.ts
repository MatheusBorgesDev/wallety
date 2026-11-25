import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./app.js";

describe("app", () => {
  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not Found" });
  });
});

describe("GET /health/live", () => {
  it("returns 200 without touching the database", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
