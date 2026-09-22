/**
 * Expand or refresh the vendored SQLLogicTest subset.
 *
 * Without network args this validates the local vendor tree parses.
 * Optional: SQLITE_MEM_SLT_URL=<url> downloads a single .test file into vendor/sqllogictest/test/
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSlt } from "../tests/fuzz/slt-runner.ts";

const root = join(import.meta.dir, "../vendor/sqllogictest");
const testDir = join(root, "test");

mkdirSync(testDir, { recursive: true });

const url = process.env.SQLITE_MEM_SLT_URL;
if (url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
  const text = await res.text();
  if (text.includes("<!DOCTYPE html>")) {
    throw new Error("URL returned HTML, not a .test file");
  }
  const name = (url.split("/").pop() ?? "downloaded.test").replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = join(testDir, name.endsWith(".test") ? name : `${name}.test`);
  writeFileSync(dest, text, "utf8");
  console.log(`wrote ${dest}`);
}

let records = 0;
for (const fileName of readdirSync(testDir).filter((n) => n.endsWith(".test"))) {
  const parsed = parseSlt(readFileSync(join(testDir, fileName), "utf8"));
  records += parsed.length;
  console.log(`${fileName}: ${parsed.length} records`);
}
console.log(`OK — ${records} total SQLLogicTest records in vendor/sqllogictest/test`);
