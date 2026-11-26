import type { Express } from "express";

export type RegisteredRoute = { method: string; path: string };

type Layer = { name: string; route?: { path: string; methods: Record<string, boolean> } };

// Every route Express will actually answer, in OpenAPI path style. This reads the
// application itself, not the route declarations, so it also sees a route that was
// added behind their back.
export function listRegisteredRoutes(app: Express): RegisteredRoute[] {
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  return stack.flatMap((layer) => {
    if (layer.name === "router") {
      // The prefix of a mounted router cannot be read back, so its routes could not be checked.
      throw new Error("Mounted routers are not allowed: register every route on the application itself");
    }
    if (!layer.route) {
      return [];
    }
    const path = layer.route.path.replace(/:(\w+)/g, "{$1}");
    return Object.keys(layer.route.methods).map((method) => ({ method, path }));
  });
}
