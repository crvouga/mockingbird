import { mkdir, rm } from "node:fs/promises";
import { $ } from "bun";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const build = Bun.spawn(
  [
    "bunx",
    "esbuild",
    "src/index.ts",
    "src/unstable.ts",
    "--bundle",
    "--format=esm",
    "--outdir=dist",
    "--platform=browser",
    "--target=es2022",
    "--sourcemap",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const code = await build.exited;
if (code !== 0) process.exit(code);

await $`tsc -p tsconfig.build.json`;

// tsc keeps `.ts` specifiers in .d.ts even with rewriteRelativeImportExtensions
// when the source uses allowImportingTsExtensions. Consumers resolve `.js` → `.d.ts`.
const dtsGlob = new Bun.Glob("**/*.d.ts");
let rewritten = 0;
for await (const file of dtsGlob.scan({ cwd: "dist" })) {
  const path = `dist/${file}`;
  const text = await Bun.file(path).text();
  const next = text.replaceAll(/\b((?:from|import)\s*(?:\(\s*)?)(["'])(\.[^"']+)\.ts\2/g, "$1$2$3.js$2");
  if (next !== text) {
    await Bun.write(path, next);
    rewritten++;
  }
}
if (rewritten === 0) {
  console.error("Build incomplete: no declaration import specifiers were rewritten to .js");
  process.exit(1);
}

const mod = await import(new URL("../dist/index.js", import.meta.url).href);
if (typeof mod.Database !== "function") {
  console.error("Build incomplete: Database export missing at runtime");
  process.exit(1);
}

const unstable = await import(new URL("../dist/unstable.js", import.meta.url).href);
if (typeof unstable.parse !== "function") {
  console.error("Build incomplete: unstable.parse export missing at runtime");
  process.exit(1);
}

console.log("Built sqlite-mem → dist/");
