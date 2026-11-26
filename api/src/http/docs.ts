import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Express } from "express";

const swaggerUiDir = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

// The only files of the Swagger UI distribution that are served.
const assets: Record<string, string> = {
  "swagger-ui.css": "text/css",
  "swagger-ui-bundle.js": "text/javascript",
  "swagger-ui-standalone-preset.js": "text/javascript",
  "favicon-32x32.png": "image/png",
};

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wallety API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
    <link rel="icon" type="image/png" href="/docs/favicon-32x32.png" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-ui-standalone-preset.js"></script>
    <script src="/docs/initializer.js"></script>
  </body>
</html>
`;

// A file of its own, not an inline script, so the page works under a Content-Security-Policy
// that forbids inline scripts.
const initializer = `window.ui = SwaggerUIBundle({
  url: "/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  persistAuthorization: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: "BaseLayout",
});
`;

export function mountDocs(app: Express, document: unknown): void {
  app.get("/openapi.json", (_req, res) => {
    res.json(document);
  });
  app.get("/docs", (_req, res) => {
    res.type("html").send(page);
  });
  app.get("/docs/initializer.js", (_req, res) => {
    res.type("text/javascript").send(initializer);
  });
  app.get("/docs/:asset", (req, res, next) => {
    const contentType = assets[req.params.asset];
    if (!contentType) {
      next();
      return;
    }
    res.type(contentType).sendFile(join(swaggerUiDir, req.params.asset), { maxAge: "1h" });
  });
}
