import { describe, it, expect } from "vitest";
import { Router } from "express";
import request from "supertest";
import { createApp } from "../app.js";
import { listRegisteredRoutes } from "./route-inventory.js";

// Routes that are deliberately absent from the public document.
const undocumented = [
  /^get \/openapi\.json$/,
  /^get \/docs(\/.*)?$/,
  // Operational endpoints, protected by a secret and not part of the public contract.
  /^post \/internal\/.+$/,
];

describe("OpenAPI document", () => {
  it("documents every route the application answers", async () => {
    const app = createApp();
    const document = (await request(app).get("/openapi.json")).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    const registered = listRegisteredRoutes(app).map(({ method, path }) => `${method} ${path}`);
    expect(registered.length).toBeGreaterThan(3);

    const missing = registered
      .filter((route) => !undocumented.some((pattern) => pattern.test(route)))
      .filter((route) => {
        const [method, path] = route.split(" ") as [string, string];
        return document.paths[path]?.[method] === undefined;
      });

    expect(missing).toEqual([]);
  });

  it("refuses a mounted router, whose routes it could not see", () => {
    const app = createApp();
    app.use("/hidden", Router());
    expect(() => listRegisteredRoutes(app)).toThrow(/Mounted routers are not allowed/);
  });

  it("is a valid OpenAPI 3.1 document with the webhook and the error shape", async () => {
    const document = (await request(createApp()).get("/openapi.json")).body;
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("Wallety API");
    expect(document.webhooks["transfer.posted"].post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/TransferPostedEvent",
    });
    expect(document.components.schemas.Error.properties.error.required).toEqual(["code", "message"]);
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  });
});
