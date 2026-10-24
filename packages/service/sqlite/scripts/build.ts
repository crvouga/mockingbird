import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { inlineCoreTypes } from "../../../../scripts/inline-core-types.ts";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const build = Bun.spawn(
  [
    "bunx",
    "esbuild",
    "src/index.ts",
    "src/unstable.ts",
    "src/admin.ts",
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

const socketBuild = Bun.spawn(
  [
    "bunx",
    "esbuild",
    "src/socket/index.ts",
    "src/socket/cli.ts",
    "--bundle",
    "--format=esm",
    "--outdir=dist/socket",
    "--platform=node",
    "--target=node20",
    "--external:node:*",
    "--sourcemap",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const socketCode = await socketBuild.exited;
if (socketCode !== 0) process.exit(socketCode);

await $`tsc -p tsconfig.build.json`;
await $`tsc -p tsconfig.build.socket.json`;

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

await Bun.write(
  "dist/admin.d.ts",
  `import type { Database, DatabaseOptions } from "./api/database.js";

export interface AdminOptions {
  database?: Database;
  adminKey?: string;
  databaseOptions?: DatabaseOptions;
}

export interface AdminServer {
  fetch(request: Request): Promise<Response>;
}

export declare function createAdmin(options?: AdminOptions): AdminServer;
`,
);

await inlineCoreTypes(fileURLToPath(new URL("..", import.meta.url)));

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

const admin = await import(new URL("../dist/admin.js", import.meta.url).href);
if (typeof admin.createAdmin !== "function") {
  console.error("Build incomplete: createAdmin export missing at runtime");
  process.exit(1);
}

const socket = await import(new URL("../dist/socket/index.js", import.meta.url).href);
if (typeof socket.serve !== "function" || typeof socket.connect !== "function") {
  console.error("Build incomplete: socket serve/connect export missing at runtime");
  process.exit(1);
}

console.log("Built sqlite-mem → dist/");
