import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { inlineCoreTypes } from "../../../../scripts/inline-core-types.ts";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const { version } = await Bun.file("package.json").json();

const build = Bun.spawn(
  [
    "bunx",
    "esbuild",
    "src/index.ts",
    "src/unstable.ts",
    "src/admin.ts",
    "--bundle",
    `--define:MOCKINGBIRD_POSTGRES_VERSION=${JSON.stringify(version)}`,
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

// The wire-protocol server and its CLI need node:net; build them for Node, not the browser.
const serverBuild = Bun.spawn(
  [
    "bunx",
    "esbuild",
    "src/wire/index.ts",
    "src/wire/cli.ts",
    "src/server.ts",
    "--bundle",
    `--define:MOCKINGBIRD_POSTGRES_VERSION=${JSON.stringify(version)}`,
    "--format=esm",
    "--outdir=dist",
    "--outbase=src",
    "--platform=node",
    "--target=node20",
    "--external:node:*",
    "--sourcemap",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const serverCode = await serverBuild.exited;
if (serverCode !== 0) process.exit(serverCode);

await $`tsc -p tsconfig.build.json`;
await $`tsc -p tsconfig.build.wire.json`;

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

// Fleet types belong to private workspace helpers. Inline their declarations so
// consumers need only the published Postgres package, as they do for /admin.
const fleetTypes = await rollup({
  input: "dist/wire/fleet.d.ts",
  external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@crvouga/mockingbird"),
  plugins: [dts({ respectExternal: true, tsconfig: "tsconfig.build.wire.json" })],
  onwarn: (warning) => {
    throw new Error(warning.message);
  },
});
await fleetTypes.write({ file: "dist/wire/fleet.d.ts", format: "es" });
await fleetTypes.close();

// tsc would re-export the private admin helper. Publish a declaration that only
// names this package's Database.
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

const server = await import(new URL("../dist/wire/index.js", import.meta.url).href);
if (typeof server.serve !== "function") {
  console.error("Build incomplete: server serve export missing at runtime");
  process.exit(1);
}

const admin = await import(new URL("../dist/admin.js", import.meta.url).href);
if (typeof admin.createAdmin !== "function") {
  console.error("Build incomplete: createAdmin export missing at runtime");
  process.exit(1);
}

console.log("Built postgres-mem → dist/");
