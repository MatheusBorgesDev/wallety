import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const applicationDir = import.meta.dirname;
const importPattern = /from\s+["']([^"']+)["']/g;
// Use cases may import each other, the domain and hashing. Nothing that does I/O.
const allowedImport = /^(\.\/[\w-]+\.js|\.\.\/domain\/[\w-]+\.js|node:crypto)$/;

function sourceFiles(): string[] {
  return readdirSync(applicationDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
}

describe("application layer", () => {
  it("imports only the domain, itself and node:crypto: no database, no HTTP", () => {
    const sources = sourceFiles();
    expect(sources.length).toBeGreaterThan(0);

    const violations = sources.flatMap((file) =>
      [...readFileSync(join(applicationDir, file), "utf8").matchAll(importPattern)]
        .map((match) => match[1]!)
        .filter((specifier) => !allowedImport.test(specifier))
        .map((specifier) => `${file} imports ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("cannot reach the network: a use case records an event, it never delivers one", () => {
    const offenders = sourceFiles().filter((file) =>
      /\bfetch\s*\(|node:https?|node:net|undici/.test(readFileSync(join(applicationDir, file), "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
