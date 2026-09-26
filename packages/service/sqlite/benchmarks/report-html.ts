import path from "node:path";
import { renderHtmlReport } from "./harness/html-report.ts";
import type { BenchReport } from "./harness/types.ts";

const root = path.resolve(import.meta.dir);
const inputArg = process.argv[2];
const inputPath = path.resolve(root, inputArg ?? "results/default-bun.json");
const outputPath = inputPath.replace(/\.json$/i, ".html");

const file = Bun.file(inputPath);
if (!(await file.exists())) {
  console.error(`missing report JSON: ${inputPath}`);
  console.error("usage: bun run benchmarks/report-html.ts [path/to/report.json]");
  process.exit(1);
}

const report = (await file.json()) as BenchReport;
if (!report?.results || !Array.isArray(report.results)) {
  console.error(`invalid BenchReport: ${inputPath}`);
  process.exit(1);
}

await Bun.write(outputPath, renderHtmlReport(report));
console.log(`Wrote ${outputPath}`);
