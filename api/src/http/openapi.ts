import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema } from "./errors.js";
import type { AnyRoute, ResponseSpec } from "./route.js";

extendZodWithOpenApi(z);

export type WebhookSpec = {
  name: string;
  summary: string;
  description: string;
  headers: z.ZodObject;
  body: z.ZodType;
};

export type OpenApiInfo = { title: string; version: string; description: string };

const json = (schema: z.ZodType) => ({ "application/json": { schema } });

function responseEntry(spec: ResponseSpec) {
  return {
    description: spec.description,
    ...(spec.schema ? { content: json(spec.schema) } : {}),
    ...(spec.headers
      ? {
          headers: Object.fromEntries(
            Object.entries(spec.headers).map(([name, description]) => [
              name,
              { description, schema: { type: "string" as const } },
            ]),
          ),
        }
      : {}),
  };
}

const errorEntry = (description: string, headers?: Record<string, string>) =>
  responseEntry({ description, schema: errorResponseSchema, headers });

// Responses every route of a given kind can produce, so that no declaration has to repeat them.
function impliedResponses(route: AnyRoute): Record<number, ReturnType<typeof responseEntry>> {
  const implied: Record<number, ReturnType<typeof responseEntry>> = {};
  if (route.request) {
    implied[400] = errorEntry("The request failed validation");
  }
  if (route.access === "user") {
    implied[401] = errorEntry("Missing, invalid or expired access token");
  }
  if (route.rateLimit) {
    implied[429] = errorEntry("Too many requests", { "Retry-After": "Seconds to wait before trying again" });
  }
  return implied;
}

export function buildOpenApiDocument(routes: AnyRoute[], webhooks: WebhookSpec[], info: OpenApiInfo) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Access token returned by the login and registration routes",
  });

  for (const route of routes) {
    const responses = Object.fromEntries(
      Object.entries(route.responses).map(([status, spec]) => [status, responseEntry(spec)]),
    );
    registry.registerPath({
      method: route.method,
      path: route.path,
      tags: [route.tag],
      summary: route.summary,
      description: route.description,
      security: route.access === "user" ? [{ bearerAuth: [] }] : [],
      request: {
        params: route.request?.params,
        query: route.request?.query,
        headers: route.request?.headers,
        ...(route.request?.body ? { body: { required: true, content: json(route.request.body) } } : {}),
      },
      responses: { ...impliedResponses(route), ...responses },
    });
  }

  for (const webhook of webhooks) {
    registry.registerWebhook({
      method: "post",
      path: webhook.name,
      summary: webhook.summary,
      description: webhook.description,
      request: { headers: webhook.headers, body: { required: true, content: json(webhook.body) } },
      responses: {
        200: { description: "The event was accepted. Any 2xx status counts as delivered" },
      },
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: "3.1.0", info });
}
