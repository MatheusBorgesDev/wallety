import type { Request, Response, NextFunction } from "express";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: "Not Found" });
}

// Four arguments: Express recognizes an error handler by its arity.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const message = err instanceof Error ? err.message : "Internal Server Error";
  res.status(500).json({ error: message });
}
