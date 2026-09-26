/**
 * Browser performance smoke: run a small insert/select workload against the
 * built ESM in headless Chromium (4x CPU throttle) and print timings.
 *
 *   bun run build && bun run scripts/browser-perf.ts
 */
import path from "node:path";

interface PageLike {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
}

interface BrowserLike {
  newContext(): Promise<{
    newPage(): Promise<PageLike>;
    newCDPSession(page: PageLike): Promise<{ send(method: string, params: object): Promise<unknown> }>;
  }>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: { launch(options: { headless: boolean }): Promise<BrowserLike> };
}

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

let playwright: PlaywrightLike;
try {
  playwright = (await dynamicImport("playwright")) as PlaywrightLike;
} catch {
  console.warn("SKIP browser performance smoke: optional package 'playwright' is not installed.");
  console.warn("Install it with `bun add -d playwright && bunx playwright install chromium`.");
  process.exit(0);
}

const root = path.join(import.meta.dir, "..");
const distEntry = path.join(root, "dist/index.js");
if (!(await Bun.file(distEntry).exists())) {
  console.error("Missing dist/index.js. Run `bun run build` before the browser performance smoke.");
  process.exit(1);
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/dist/index.js" || pathname === "/dist/index.js.map") {
      return new Response(Bun.file(path.join(root, pathname.slice(1))), {
        headers: { "content-type": pathname.endsWith(".map") ? "application/json" : "text/javascript" },
      });
    }
    return new Response("<!doctype html><meta charset=utf-8><title>postgres-mem performance smoke</title>", {
      headers: { "content-type": "text/html" },
    });
  },
});

const browser = await playwright.chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const metrics = await page.evaluate(async () => {
    const load = new Function("return import('/dist/index.js')") as () => Promise<{
      Database: new () => {
        exec(sql: string): void;
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
          get<T>(...params: unknown[]): T | undefined;
        };
        close(): void;
      };
    }>;
    const { Database } = await load();
    const db = new Database();
    db.exec("CREATE TABLE t (id int, name text)");
    const percentile95 = (samples: number[]): number => {
      samples.sort((a, b) => a - b);
      return samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    };
    const measure = (fn: () => void): number => {
      const start = performance.now();
      fn();
      return performance.now() - start;
    };
    const insert = db.prepare("INSERT INTO t(id, name) VALUES ($1, $2)");
    const insertStart = performance.now();
    for (let i = 1; i <= 1000; i++) insert.run(i, `v${i}`);
    const insert1000Ms = performance.now() - insertStart;
    const prepared = db.prepare("SELECT name FROM t WHERE id = $1");
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 20; j++) prepared.get(500);
      for (let j = 0; j < 1000; j++) prepared.get(500);
    }
    const lookupSamples = Array.from({ length: 8 }, () =>
      measure(() => {
        for (let i = 0; i < 20; i++) prepared.get(500);
      }),
    );
    const preparedSamples = Array.from({ length: 8 }, () =>
      measure(() => {
        for (let i = 0; i < 1000; i++) prepared.get(500);
      }),
    );
    db.close();
    return {
      insert1000Ms,
      lookup20P95Ms: percentile95(lookupSamples),
      preparedExecute1000P95Ms: percentile95(preparedSamples),
    };
  });

  console.log(`Chromium 4x throttle: ${JSON.stringify(metrics)}`);
} finally {
  await browser.close();
  server.stop(true);
}
