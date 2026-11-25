import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

type LoggerOptions = {
  level?: string;
  destination?: DestinationStream;
};

// Google Cloud Logging reads the level from a `severity` field with these names.
const severityByLevel: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      messageKey: "message",
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ severity: severityByLevel[label] ?? "DEFAULT" }),
      },
      // Second line of defense: the request serializer already drops headers.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
          "password",
          "*.password",
          "token",
          "*.token",
        ],
        censor: "[redacted]",
      },
    },
    options.destination,
  );
}
