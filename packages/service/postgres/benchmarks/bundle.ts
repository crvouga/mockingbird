import path from "node:path";
import { gzipSync } from "node:zlib";
import budgets from "./budgets.json";

const root = path.resolve(import.meta.dir, "..");
const file = Bun.file(path.join(root, "dist/index.js"));
if (!(await file.exists())) {
  console.error("dist/index.js missing; run bun run build first");
  process.exit(1);
}
const bytes = new Uint8Array(await file.arrayBuffer());
const gzip = gzipSync(bytes);

let brotliBytes: number | undefined;
try {
  const zlib = await import("node:zlib");
  if (typeof zlib.brotliCompressSync === "function") {
    brotliBytes = zlib.brotliCompressSync(bytes).byteLength;
  }
} catch {
  brotliBytes = undefined;
}

const result = {
  file: "dist/index.js",
  uncompressed: bytes.byteLength,
  gzip: gzip.byteLength,
  brotli: brotliBytes ?? null,
};

console.log(JSON.stringify(result, null, 2));
await Bun.write(path.join(import.meta.dir, "results/bundle.json"), `${JSON.stringify(result, null, 2)}\n`);

const bundleBudget = budgets.bundle;
const failures: string[] = [];
if (result.uncompressed > bundleBudget.maxUncompressedBytes) {
  failures.push(`uncompressed ${result.uncompressed} > budget ${bundleBudget.maxUncompressedBytes}`);
}
if (result.gzip > bundleBudget.maxGzipBytes) {
  failures.push(`gzip ${result.gzip} > budget ${bundleBudget.maxGzipBytes}`);
}
if (failures.length > 0) {
  console.error("Bundle size budget exceeded:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("Bundle size within budget");
