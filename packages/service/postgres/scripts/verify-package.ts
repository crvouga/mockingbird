/**
 * Fail-fast package integrity gate for CI and release.
 * Checks built artifacts, npm pack contents, and publint.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const errors: string[] = [];

function fail(message: string): void {
  errors.push(message);
  console.error(`::error::${message}`);
}

function requireFile(rel: string): void {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    fail(`Missing required package file: ${rel}`);
  }
}

async function requireJsdoc(rel: string, needles: string[]): Promise<void> {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  const text = await Bun.file(abs).text();
  for (const needle of needles) {
    if (!text.includes(needle)) {
      fail(
        `${rel} is missing JSDoc ${JSON.stringify(needle)}. Keep comments on the source declarations and do not set removeComments.`,
      );
    }
  }
}

console.log("verify-package: checking build outputs…");

requireFile("dist/index.js");
requireFile("dist/index.d.ts");
requireFile("dist/unstable.js");
requireFile("dist/unstable.d.ts");
requireFile("dist/api/database.d.ts");
requireFile("dist/api/statement.d.ts");
requireFile("LICENSE");
requireFile("README.md");
requireFile("package.json");

const pkg = await Bun.file(join(root, "package.json")).json();

if (pkg.name !== "@crvouga/postgres-mem") {
  fail(`package.json name must be "@crvouga/postgres-mem" (got ${JSON.stringify(pkg.name)})`);
}

if (!pkg.exports?.["."]?.import || !pkg.exports?.["."]?.types) {
  fail('package.json exports["."] must define "import" and "types"');
}
if (!pkg.exports?.["./unstable"]?.import || !pkg.exports?.["./unstable"]?.types) {
  fail('package.json exports["./unstable"] must define "import" and "types"');
}

const exportKeys = Object.keys(pkg.exports).sort();
if (exportKeys.length !== 2 || exportKeys[0] !== "." || exportKeys[1] !== "./unstable") {
  fail(`package.json exports must be exactly "." and "./unstable" (got ${JSON.stringify(exportKeys)})`);
}

const exportImport = String(pkg.exports["."].import).replace(/^\.\//, "");
const exportTypes = String(pkg.exports["."].types).replace(/^\.\//, "");
requireFile(exportImport);
requireFile(exportTypes);

const unstableImport = String(pkg.exports["./unstable"].import).replace(/^\.\//, "");
const unstableTypes = String(pkg.exports["./unstable"].types).replace(/^\.\//, "");
requireFile(unstableImport);
requireFile(unstableTypes);

if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
  fail('package.json "files" must include "dist" so the tarball ships the build');
}

if (!pkg.repository?.url) {
  fail('package.json must set "repository.url" for npm and GitHub releases');
}

if (!pkg.publishConfig?.access) {
  fail('package.json must set publishConfig.access (expected "public")');
}

if (pkg.type !== "module") {
  fail('package.json must set "type": "module" (ESM-only isomorphic package)');
}

if (exportImport !== "dist/index.js") {
  fail(
    `exports["."].import must be "./dist/index.js" (browser-built ESM), got ${JSON.stringify(pkg.exports["."].import)}`,
  );
}

console.log("verify-package: checking dist is isomorphic (no Node/Bun APIs)…");
const bundle = await Bun.file(join(root, "dist/index.js")).text();
const forbiddenInBundle: Array<{ label: string; test: (text: string) => boolean }> = [
  { label: 'from "node:…"', test: (t) => /from\s+["']node:/.test(t) },
  { label: 'from "bun:…"', test: (t) => /from\s+["']bun:/.test(t) },
  { label: 'import("node:…") / import("bun:…")', test: (t) => /import\s*\(\s*["'](?:node|bun):/.test(t) },
  { label: "require(", test: (t) => /\brequire\s*\(/.test(t) },
  { label: "__dirname", test: (t) => /\b__dirname\b/.test(t) },
  { label: "__filename", test: (t) => /\b__filename\b/.test(t) },
  { label: "module.exports", test: (t) => /\bmodule\.exports\b/.test(t) },
  { label: "process.cwd", test: (t) => /\bprocess\.cwd\b/.test(t) },
  { label: "process.exit", test: (t) => /\bprocess\.exit\b/.test(t) },
  { label: "process.env", test: (t) => /\bprocess\.env\b/.test(t) },
  { label: "WebAssembly", test: (t) => /\bWebAssembly\b/.test(t) },
  { label: ".wasm asset", test: (t) => /\.wasm["'`]/.test(t) },
  { label: "eval(", test: (t) => /\beval\s*\(/.test(t) },
  { label: "new Function", test: (t) => /\bnew\s+Function\b/.test(t) },
  { label: "new SharedArrayBuffer", test: (t) => /\bnew\s+SharedArrayBuffer\b/.test(t) },
  { label: "Atomics.", test: (t) => /\bAtomics\s*\./.test(t) },
];
for (const item of forbiddenInBundle) {
  if (item.test(bundle)) {
    fail(
      `dist/index.js contains Node/Bun-only pattern (${item.label}); keep the esbuild --platform=browser bundle isomorphic`,
    );
  }
}

console.log("verify-package: checking JSDoc in declaration emit…");
await requireJsdoc("dist/api/database.d.ts", ["Pure TypeScript in-memory PostgreSQL", "@example"]);
await requireJsdoc("dist/api/statement.d.ts", ["Prepared SQL statement"]);

console.log("verify-package: checking published TypeScript types…");
const dtsFiles = [...new Bun.Glob("**/*.d.ts").scanSync({ cwd: join(root, "dist") })].map((rel) => `dist/${rel}`);
if (dtsFiles.length === 0) {
  fail("No .d.ts files under dist/");
}
const tsSpecifier = /(?:from|import)\s*(?:\(\s*)?["'][^"']+\.ts["']/;
for (const rel of dtsFiles) {
  const text = await Bun.file(join(root, rel)).text();
  if (tsSpecifier.test(text)) {
    fail(`${rel} contains .ts import specifiers; consumers cannot resolve those paths`);
  }
}

const indexDts = await Bun.file(join(root, "dist/index.d.ts")).text();
for (const exported of [
  "Database",
  "Statement",
  "PostgresError",
  "BindValue",
  "JsValue",
  "QueryRow",
  "ErrorCategory",
  "DatabaseOptions",
  "RunResult",
  "ResultSet",
]) {
  if (!indexDts.includes(exported)) {
    fail(`dist/index.d.ts is missing public type ${exported}`);
  }
}
for (const leaked of ["executeStatement", "EngineCtx", "encodeDatabaseState", "tokenize", "Prng"]) {
  if (indexDts.includes(leaked)) {
    fail(`dist/index.d.ts must not export unstable symbol ${leaked}; move it to ./unstable`);
  }
}

const unstableDts = await Bun.file(join(root, "dist/unstable.d.ts")).text();
for (const exported of ["parse", "tokenize", "Prng", "DatabaseState", "executeStatement"]) {
  if (!unstableDts.includes(exported)) {
    fail(`dist/unstable.d.ts is missing ${exported}`);
  }
}

const databaseDts = await Bun.file(join(root, "dist/api/database.d.ts")).text();
for (const leaked of ["readonly state", "readonly prng", "readonly transactions", "now: Clock", "assertOpen("]) {
  if (databaseDts.includes(leaked)) {
    fail(`dist/api/database.d.ts still publishes internal member (${leaked}); enable stripInternal`);
  }
}

const statementDts = await Bun.file(join(root, "dist/api/statement.d.ts")).text();
if (!/\bprivate constructor\b/.test(statementDts)) {
  fail("dist/api/statement.d.ts must keep Statement's constructor private so consumers use Database.prepare");
}
if (/\bcreateFromSql\b/.test(statementDts) || /\bstatic create\b/.test(statementDts)) {
  fail("dist/api/statement.d.ts still publishes Statement construction helpers; mark them @internal");
}

if (errors.length > 0) {
  console.error("");
  console.error("verify-package FAILED — fix the issues above before publishing.");
  console.error("Run: bun run build && bun run verify-package");
  process.exit(1);
}

console.log("verify-package: running npm pack (dry list)…");
// --ignore-scripts avoids prepare/husky stdout polluting --json
const pack = await $`npm pack --dry-run --json --ignore-scripts`.cwd(root).quiet().nothrow();
if (pack.exitCode !== 0) {
  console.error(pack.stderr.toString() || pack.stdout.toString());
  fail("npm pack --dry-run failed — the package cannot be packed for npm");
  console.error("");
  console.error("verify-package FAILED.");
  process.exit(1);
}

let packEntries: Array<{ filename?: string; files?: Array<{ path: string }> }>;
try {
  const raw = pack.stdout.toString().trim();
  const jsonStart = raw.indexOf("[");
  packEntries = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
} catch (err) {
  fail(`npm pack --dry-run returned invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  process.exit(1);
}

const files = packEntries[0]?.files?.map((f) => f.path) ?? [];
const requiredInTarball = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/unstable.js",
  "dist/unstable.d.ts",
  "dist/api/database.d.ts",
  "dist/api/statement.d.ts",
  "package.json",
  "LICENSE",
  "README.md",
];
for (const needed of requiredInTarball) {
  if (!files.some((p) => p === needed || p.endsWith(`/${needed}`))) {
    fail(`npm tarball is missing ${needed}. Check package.json "files" and the build output.`);
  }
}

if (files.length < 5) {
  fail(`npm tarball looks empty (${files.length} files). Refusing to publish.`);
}

console.log(`verify-package: tarball would include ${files.length} files`);

console.log("verify-package: running publint…");
const publint = await $`bunx publint`.cwd(root).nothrow();
if (publint.exitCode !== 0) {
  fail("publint reported packaging problems — see output above");
  console.error("");
  console.error("verify-package FAILED.");
  process.exit(1);
}

console.log("verify-package: typechecking package consumers (NodeNext)…");
const packageTypes = await $`bun run typecheck:package`.cwd(root).nothrow();
if (packageTypes.exitCode !== 0) {
  fail("Published .d.ts failed consumer typecheck (tsc -p tsconfig.package.json)");
  console.error("");
  console.error("verify-package FAILED.");
  process.exit(1);
}

console.log("verify-package: running arethetypeswrong…");
const attw = await $`bunx --bun attw --pack . --profile esm-only`.cwd(root).nothrow();
if (attw.exitCode !== 0) {
  fail("arethetypeswrong reported type packaging problems — see output above");
  console.error("");
  console.error("verify-package FAILED.");
  process.exit(1);
}

if (errors.length > 0) {
  console.error("");
  console.error("verify-package FAILED — fix the issues above before publishing.");
  process.exit(1);
}

console.log("verify-package: OK");
