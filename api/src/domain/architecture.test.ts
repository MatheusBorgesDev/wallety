import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const domainDir = import.meta.dirname;
const importPattern = /from\s+["']([^"']+)["']/g;

function importsOf(file: string): string[] {
  const source = readFileSync(join(domainDir, file), "utf8");
  return [...source.matchAll(importPattern)].map((match) => match[1]!);
}

describe("domain layer", () => {
  it("imports nothing but its own modules: no database, HTTP or config", () => {
    const sources = readdirSync(domainDir).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);

    const violations = sources.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => !/^\.\/[\w-]+\.js$/.test(specifier))
        .map((specifier) => `${file} imports ${specifier}`),
    );

    expect(violations).toEqual([]);
  });
});
