/**
 * Fail CI when tests use .skip / test.todo / describe.skip without a register entry.
 * Register: tests/meta/skips.json
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TESTS = join(ROOT, "tests");
const REGISTER = join(ROOT, "tests/meta/skips.json");

interface SkipEntry {
  id: string;
  reason: string;
  expiry: string;
  pattern: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const register = JSON.parse(readFileSync(REGISTER, "utf8")) as { skips: SkipEntry[] };
const today = new Date().toISOString().slice(0, 10);
const skipRe = /\b(?:test|describe|it)\.(?:skip|todo)\s*\(/g;

const undeclared: string[] = [];
const expired: string[] = [];

for (const entry of register.skips) {
  if (entry.expiry < today) expired.push(entry.id);
}

for (const file of walk(TESTS)) {
  if (file.includes(`${join("tests", "meta")}`)) continue;
  const text = readFileSync(file, "utf8");
  const matches = text.match(skipRe);
  if (!matches) continue;
  for (const _ of matches) {
    const rel = file.slice(ROOT.length + 1);
    const allowed = register.skips.some((s) => rel.includes(s.pattern) || text.includes(s.id));
    if (!allowed) undeclared.push(rel);
  }
}

if (expired.length > 0) {
  console.error(`Expired skip register entries: ${expired.join(", ")}`);
}
if (undeclared.length > 0) {
  console.error(`Undocumented skips/todos in: ${[...new Set(undeclared)].join(", ")}`);
}
if (expired.length > 0 || undeclared.length > 0) process.exit(1);
console.log(`skip-register: ok (${register.skips.length} registered, none undeclared)`);
