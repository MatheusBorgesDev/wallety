import { readFileSync } from "node:fs";
import { renderComparison, renderReport } from "./report.js";
import type { ExperimentResult } from "./types.js";

// Prints the tables for one or more result files. With several files, also prints how the
// median throughput of each group moved from one run to the next.
const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: npm run experiment:report -- <result.json> [more-results.json ...]");
  process.exit(1);
}
const results = paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as ExperimentResult);
for (const result of results) {
  console.log(`${renderReport(result)}`);
}
if (results.length > 1) {
  console.log(renderComparison(results));
}
