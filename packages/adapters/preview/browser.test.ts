import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chromium } from "@playwright/test"
import { build } from "esbuild"

test("two apps on static pages share an actual worker; reset, disconnect and streaming errors stay isolated", async () => {
  const bundle = async (contents: string) => {
    const result = await build({
      stdin: { contents, resolveDir: import.meta.dir },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    })
    return result.outputFiles[0]?.text ?? ""
  }
  const worker = await bundle(`
    import { createPreviewHost, installPreviewWorkerHost } from './src/index.ts';
    const host = createPreviewHost({ artifact:'fixture-sha', boot: ({generation}) => ({ fetch: (request) => {
      const url = new URL(request.url);
      if(url.pathname === '/status') return Response.json(host.status());
      if(url.pathname === '/error') return new Response(new ReadableStream({pull(c){c.error(Error('stream failed'))}},{highWaterMark:0}));
      return new Response(url.hostname + ':' + generation);
    } }) });
    self.addEventListener('connect', event => event.ports[0].addEventListener('message', event => { if(event.data === 'reset') void host.reset(); }));
    installPreviewWorkerHost(host,self);
  `)
  const client = await bundle(`
    import { connectSharedPreviewWorker } from './src/index.ts';
    globalThis.connect = () => connectSharedPreviewWorker('/worker.js',{application:'fixture',artifact:'fixture-sha',generation:0});
  `)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/worker.js")
        return new Response(worker, { headers: { "content-type": "text/javascript" } })
      if (path === "/client.js")
        return new Response(client, { headers: { "content-type": "text/javascript" } })
      return new Response('<!doctype html><script type="module" src="/client.js"></script>', {
        headers: { "content-type": "text/html" },
      })
    },
  })
  if (!existsSync(chromium.executablePath())) {
    const installed = Bun.spawnSync(
      ["bunx", "playwright", "install", ...(process.env.CI ? ["--with-deps"] : []), "chromium"],
      { cwd: import.meta.dir, stdout: "ignore", stderr: "inherit" },
    )
    if (installed.exitCode !== 0) throw new Error("Chromium installation failed")
  }
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(server.url.href)
    await page.waitForFunction("typeof globalThis.connect === 'function'")
    const result = await page.evaluate(`(async()=>{
      const first=connect(), second=connect();
      const before=await Promise.all([first.fetch('http://first.app/').then(r=>r.text()),second.fetch('http://second.app/').then(r=>r.text())]);
      first.dispose();
      const after=await second.fetch('http://second.app/').then(r=>r.text());
      const error=await second.fetch('http://second.app/error').then(r=>r.text()).then(()=>null,e=>e.message);
      second.worker.port.postMessage('reset');
      await new Promise(r=>setTimeout(r,30));
      const third=connect();
      const reset=await third.fetch('http://first.app/').then(r=>r.text());
      const status=await third.fetch('http://first.app/status').then(r=>r.json());
      second.dispose();third.dispose();
      return {before,after,error,reset,status};
    })()`)
    expect(result).toMatchObject({
      before: ["first.app:0", "second.app:0"],
      after: "second.app:0",
      error: expect.any(String),
      reset: "first.app:1",
      status: { state: "ready", generation: 1, artifact: "fixture-sha" },
    })
  } finally {
    await browser.close()
    await server.stop(true)
  }
}, 120_000)
