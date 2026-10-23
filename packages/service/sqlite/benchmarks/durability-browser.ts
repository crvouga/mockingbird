/** Serve the real-browser durability/recovery benchmark. Open the printed URL, then reload. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = join(import.meta.dir, "..");
const wasmRoot = dirname(fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.js")));
const files = new Map([
  ["/sqlite.js", join(serviceRoot, "dist/index.js")],
  ["/postgres.js", join(serviceRoot, "../postgres/dist/index.js")],
  ["/sql-wasm.js", join(wasmRoot, "sql-wasm.js")],
  ["/sql-wasm.wasm", join(wasmRoot, "sql-wasm.wasm")],
]);

const html = String.raw`<!doctype html><meta charset="utf-8">
<title>Mockingbird browser durability benchmark</title>
<style>body{font:16px system-ui;margin:2rem}pre{white-space:pre-wrap}</style>
<h1>Browser durability and runtime</h1><pre id="result">Running…</pre>
<script src="/sql-wasm.js"></script><script type="module">
import * as sqlite from '/sqlite.js';
import * as postgres from '/postgres.js';
const result = document.querySelector('#result');
const report = { userAgent: navigator.userAgent, url: location.href, runId: Date.now() + '-' + Math.random(), results: [], recovery: [] };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const measure = async (name, run, count = 1) => {
  await run();
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    await run();
    samples.push((performance.now() - start) / count);
  }
  samples.sort((a,b) => a-b);
  report.results.push({ name, medianMs: samples[4], p95Ms: samples[8], samples: 9 });
  result.textContent = JSON.stringify(report, null, 2);
};
try {
  const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  for (const n of [1000, 10000]) {
    for (const engine of ['mockingbird', 'sql.js']) {
      const db = engine === 'mockingbird' ? new sqlite.Database() : new SQL.Database();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO t VALUES (?, ?)');
      const start = performance.now();
      db.exec('BEGIN');
      for (let i = 0; i < n; i++) engine === 'mockingbird' ? insert.run(i, 'row-' + i) : insert.run([i, 'row-' + i]);
      db.exec('COMMIT');
      report.results.push({ name: engine + '/insert/' + n, totalMs: performance.now() - start });
      const lookup = db.prepare('SELECT name FROM t WHERE id = ?');
      await measure(engine + '/lookup/' + n, () => {
        for (let i = 0; i < 5000; i++) {
          let row;
          if (engine === 'mockingbird') row = lookup.get(i % n);
          else { lookup.reset(); lookup.bind([i % n]); check(lookup.step(), 'missing wasm row'); row = lookup.getAsObject(); }
          check(row.name === 'row-' + (i % n), 'incorrect lookup');
        }
      }, 5000);
      if (engine === 'sql.js') { insert.free(); lookup.free(); }
      db.close();
    }
  }
  for (const [engine, module] of [['sqlite', sqlite], ['postgres', postgres]]) {
    for (const adapter of ['indexedDB', 'localStorage']) {
      const backend = adapter === 'indexedDB'
        ? new module.IndexedDBDurabilityBackend({ name: 'mockingbird-browser-benchmark' })
        : new module.LocalStorageDurabilityBackend({ prefix: 'mockingbird-browser-benchmark:' });
      const key = engine + '/' + adapter + '/' + Date.now();
      const handle = await module.openDurableDatabase({ key, backend });
      report.stage = engine + '/' + adapter;
      const db = handle.value;
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value INTEGER)');
      const insert = db.prepare(engine === 'sqlite' ? 'INSERT INTO t VALUES (?, ?)' : 'INSERT INTO t VALUES ($1, $2)');
      db.transaction(() => { for (let i = 0; i < 1000; i++) insert.run(i, 0); });
      const saveStart = performance.now();
      await handle.flush();
      report.results.push({ name: engine + '/' + adapter + '/initial-save', totalMs: performance.now() - saveStart });
      await measure(engine + '/' + adapter + '/unchanged-flush', () => handle.flush());
      const update = db.prepare('UPDATE t SET value = value + 1 WHERE id = ' + (engine === 'sqlite' ? '?' : '$1'));
      await measure(engine + '/' + adapter + '/100-updates-and-save', () => handle.write((db) => db.transaction(() => {
        for (let i = 0; i < 100; i++) update.run(i);
      })));
      await handle.close();
      const reopened = await module.openDurableDatabase({ key, backend });
      check(Number(reopened.value.query('SELECT COUNT(*) AS n FROM t')[0].n) === 1000, 'lost rows');
      check(Number(reopened.value.query('SELECT value FROM t WHERE id = 0')[0].value) === 10, 'lost updates');
      await reopened.close();
      report.recovery.push(engine + '/' + adapter + ': passed');

      // This stable key proves persistence across an actual page reload, not just reconnect.
      const probe = await module.openDurableDatabase({ key: engine + '/reload-proof', backend });
      probe.value.exec('CREATE TABLE IF NOT EXISTS proof (value INTEGER)');
      const prior = probe.value.query('SELECT value FROM proof');
      report.recovery.push(engine + '/' + adapter + '/prior-page: ' + (prior[0]?.value ?? 'first visit'));
      probe.value.exec('DELETE FROM proof; INSERT INTO proof VALUES (' + ((Number(prior[0]?.value) || 0) + 1) + ')');
      await probe.close();
      if (adapter === 'indexedDB') await backend.close();
    }
  }
  // A page subarray must not make IndexedDB clone/store its whole backing image.
  report.stage = 'durability/indexedDB/dense-1MiB';
  const denseBackend = new sqlite.IndexedDBDurabilityBackend({ name: 'mockingbird-browser-compact-pages' });
  const dense = await sqlite.openDurable({
    key: 'image', backend: denseBackend,
    codec: { create: () => new Uint8Array(1024 * 1024), decode: bytes => bytes, encode: bytes => bytes },
  });
  dense.value.fill(0);
  await dense.flush();
  let denseRuns = 0;
  await measure('durability/indexedDB/dense-1MiB', async () => {
    dense.value.fill(++denseRuns);
    await dense.flush();
  });
  const denseImage = await denseBackend.load('image');
  check(denseImage.bytes.length === 1024 * 1024 && denseImage.bytes.every(byte => byte === denseRuns), 'lost dense image');
  await dense.close();
  await denseBackend.close();
  const requestValue = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const pageDb = await requestValue(indexedDB.open('mockingbird-browser-compact-pages', 1));
  const savedPages = await requestValue(pageDb.transaction('pages').objectStore('pages').index('image').getAll('image'));
  pageDb.close();
  report.compactPages = {
    pageCount: savedPages.length,
    imageBytes: denseImage.bytes.length,
    backingBytes: savedPages.reduce((total, page) => total + page.bytes.buffer.byteLength, 0),
  };
  check(report.compactPages.pageCount === 64 && report.compactPages.backingBytes === 1024 * 1024, 'IndexedDB amplified page backing buffers');
  report.recovery.push('durability/indexedDB/compact-pages: passed');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error) + "\n" + error.stack; }
globalThis.benchmarkReport = report;
result.textContent = JSON.stringify(report, null, 2);
</script>`;

const server = Bun.serve({
  port: process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = files.get(path);
    if (file) return new Response(Bun.file(file));
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Browser benchmark: ${server.url}`);
