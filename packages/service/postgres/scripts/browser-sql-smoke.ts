/**
 * Browser SQL dialect smoke against built ESM + pre-recorded oracle fixtures.
 *
 *   bun run build && bun run test:browser-sql
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const FIXTURES = path.join(ROOT, "tests/browser/fixtures.json");

type FixtureCase = {
  id: string;
  setup: string[];
  sql: string;
  params?: unknown[];
  expect: { columns: string[]; values: unknown[][] } | { errorCategory: string; message?: string };
};

type FixtureFile = { version: number; oracleVersion: string; cases: FixtureCase[] };

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

interface PageLike {
  goto(url: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

interface BrowserLike {
  newContext(): Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: { launch(options: { headless: boolean }): Promise<BrowserLike> };
}

let playwright: PlaywrightLike;
try {
  playwright = (await dynamicImport("playwright")) as PlaywrightLike;
} catch {
  console.warn("SKIP browser SQL smoke: optional package 'playwright' is not installed.");
  process.exit(0);
}

const distEntry = path.join(ROOT, "dist/index.js");
if (!(await Bun.file(distEntry).exists())) {
  console.error("Missing dist/index.js. Run `bun run build` first.");
  process.exit(1);
}

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as FixtureFile;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/dist/")) {
      return new Response(Bun.file(path.join(ROOT, pathname.slice(1))), {
        headers: { "content-type": "text/javascript" },
      });
    }
    return new Response("<!doctype html><meta charset=utf-8><title>postgres-mem sql smoke</title>", {
      headers: { "content-type": "text/html" },
    });
  },
});

const browser = await playwright.chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const result = await page.evaluate(async (pack) => {
    const load = new Function("return import('/dist/index.js')") as () => Promise<{
      Database: new () => {
        exec(sql: string): void;
        prepare(sql: string): {
          result(...params: unknown[]): { columns: string[]; rows: Record<string, unknown>[] };
        };
      };
      PostgresError: new (...args: unknown[]) => { category: string };
    }>;
    const { Database } = await load();
    const failures: string[] = [];
    for (const c of pack.cases) {
      const db = new Database();
      try {
        for (const s of c.setup) db.exec(s);
        if ("errorCategory" in c.expect) {
          try {
            db.prepare(c.sql).result(...(c.params ?? []));
            failures.push(`${c.id}: expected error`);
          } catch (error) {
            const category = (error as { category?: string }).category ?? "unknown";
            if (category !== c.expect.errorCategory) {
              failures.push(`${c.id}: category ${category} ≠ ${c.expect.errorCategory}`);
            }
          }
        } else {
          const rs = db.prepare(c.sql).result(...(c.params ?? []));
          const norm = (v: unknown): unknown => {
            if (v === null || v === undefined) return null;
            if (v instanceof Uint8Array) return Array.from(v);
            return String(v);
          };
          const got = {
            columns: rs.columns,
            values: rs.rows.map((row) => rs.columns.map((col) => norm(row[col]))),
          };
          const exp = {
            columns: c.expect.columns,
            values: c.expect.values.map((row) => row.map(norm)),
          };
          if (JSON.stringify(got) !== JSON.stringify(exp)) {
            failures.push(`${c.id}: ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`);
          }
        }
      } catch (error) {
        failures.push(`${c.id}: ${(error as Error).message}`);
      }
    }
    return { ok: failures.length === 0, failures };
  }, fixtures);

  if (!result.ok) {
    console.error("browser SQL smoke FAILED");
    for (const f of result.failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`browser SQL smoke: ${fixtures.cases.length} fixtures ok (oracle ${fixtures.oracleVersion})`);
} finally {
  await browser.close();
  server.stop(true);
}
