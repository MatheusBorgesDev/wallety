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
