import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium } from "@playwright/test"

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw new Error(`${args.join(" ")}: ${err}\n${out}`)
  return out
}

test("packed runtime exposes harness UI and shared worker previews outside the workspace", async () => {
  const work = await mkdtemp(join(tmpdir(), "mockingbird-harness-consumer-"))
  try {
    const tarballs = new Map<string, string>()
    for (const relative of ["../service/sqlite", "../adapters/preview", "../ui", "."]) {
      const source = resolve(import.meta.dir, relative)
      const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
      const stage = join(work, manifest.name.split("/").at(-1))
      await mkdir(stage)
      for (const file of manifest.files) {
        if (existsSync(join(source, file))) {
          await mkdir(resolve(stage, file, ".."), { recursive: true })
          await cp(join(source, file), join(stage, file), { recursive: true })
        }
      }
      manifest.version = "0.0.0-smoke"
      for (const [name, tarball] of tarballs) {
        if (manifest.dependencies?.[name]) manifest.dependencies[name] = `file:${tarball}`
      }
      await writeFile(join(stage, "package.json"), JSON.stringify(manifest))
      const packed = JSON.parse(
        await run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", work], stage),
      )
      tarballs.set(manifest.name, join(work, packed[0].filename))
    }
    const runtimeTarball = tarballs.get("@crvouga/mockingbird-runtime")
    if (!runtimeTarball) throw new Error("runtime tarball missing")
    const app = join(work, "app")
    await mkdir(app)
    await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await run(
      [
        "npm",
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        runtimeTarball,
        "esbuild@0.28.2",
      ],
      app,
    )
    await writeFile(
      join(app, "worker.js"),
      `
      import { createPreviewHost } from '@crvouga/mockingbird-runtime/preview/host';
      const host = createPreviewHost(() => ({
        fetch: request => new Response(new URL(request.url).pathname === '/one' ? 'App one' : 'App two'),
        dispose() {},
      }));
      onmessage = ({data}) => host.connect(data.port);
    `,
    )
    await writeFile(
      join(app, "entry.js"),
      `
      import { createPreviewClient } from '@crvouga/mockingbird-runtime/preview/bridge';
      import { mountSystemHarness } from '@crvouga/mockingbird-runtime/ui';
      globalThis.result = (async () => {
        const worker = new Worker('/worker.js', {type:'module'});
        const channel = new MessageChannel();
        worker.postMessage({port:channel.port1},[channel.port1]);
        const client = createPreviewClient(channel.port2);
        const root = document.createElement('div');
        root.style.height = '400px'; document.body.append(root);
        const harness = mountSystemHarness(root, ['one','two'].map(id => ({
          id, label: id,
          async mount(element) {
            element.textContent = await (await client.fetch('http://localhost/'+id)).text();
            return () => element.replaceChildren();
          },
        })));
        try {
          await harness.show('one');
          if (!root.querySelector('[data-surface="one"]').textContent.includes('App one')) throw Error('first app');
          await harness.show('two');
          if (harness.active() !== 'two' || !root.querySelector('[data-surface="two"]').textContent.includes('App two')) throw Error('second app');
          if (!root.querySelector('[data-surface="one"]').hidden) throw Error('first app hidden');
          return 'passed';
        } finally { harness.destroy(); root.remove(); client.dispose(); worker.terminate(); }
      })();
    `,
    )
    await writeFile(
      join(app, "build.mjs"),
      `
      import { build } from 'esbuild';
      import { createPreviewClient, attachPreviewHost } from '@crvouga/mockingbird-runtime/preview/bridge';
      import { startPreviewHarness } from '@crvouga/mockingbird-runtime/preview/harness';
      import { loadPreviewArtifact } from '@crvouga/mockingbird-runtime/preview/artifacts';
      if(typeof loadPreviewArtifact !== 'function') throw Error('artifact export');
      const channel = new MessageChannel();
      const host = attachPreviewHost(channel.port1, () => new Response('node harness'));
      const client = createPreviewClient(channel.port2);
      const harness = await startPreviewHarness(client.fetch, {origin:'http://localhost:3000'});
      try {
        if(await (await fetch(harness.url)).text() !== 'node harness') throw Error('node bridge');
      } finally { await harness.close(); client.dispose(); host.dispose(); }
      await build({entryPoints:['entry.js','worker.js'],bundle:true,platform:'browser',format:'esm',outdir:'out'});
    `,
    )
    await run(["node", "build.mjs"], app)
    if (!existsSync(chromium.executablePath())) {
      await run(
        ["bunx", "playwright", "install", ...(process.env.CI ? ["--with-deps"] : []), "chromium"],
        import.meta.dir,
      )
    }
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.route("https://preview.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname
        await route.fulfill(
          path === "/"
            ? { contentType: "text/html", body: '<script type="module" src="/entry.js"></script>' }
            : {
                contentType: "text/javascript",
                body: await readFile(join(app, "out", path.slice(1))),
              },
        )
      })
      await page.goto("https://preview.test/")
      await page.waitForFunction("globalThis.result !== undefined")
      expect(await page.evaluate<string>("globalThis.result")).toBe("passed")
    } finally {
      await browser.close()
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}, 120_000)
