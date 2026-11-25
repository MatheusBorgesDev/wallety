import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import { resetDb, disconnectDb } from "../test/db.js";

describe("GET /health", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("returns 200 with db ok when the database is reachable", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });
});
