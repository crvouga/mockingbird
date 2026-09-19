import { gzipSync } from "node:zlib";
import path from "node:path";

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
