import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import type { Logger } from "./logger.js";

const REQUEST_ID_HEADER = "x-request-id";
const WELL_FORMED_ID = /^[\w-]{1,64}$/;

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // Reuse the caller's correlation id only when it is safe to log and echo back.
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === "string" && WELL_FORMED_ID.test(incoming)
          ? incoming
          : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    // Log only what is needed to follow a request. Headers and bodies never
    // reach the log, so credentials cannot leak through it.
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
