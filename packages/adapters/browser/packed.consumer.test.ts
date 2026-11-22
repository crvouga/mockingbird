import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"

const root = join(import.meta.dir, "../../..")

const run = (args: string[], cwd: string) => {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0)
    throw new Error(`${args.join(" ")}: ${result.stderr.toString()}${result.stdout.toString()}`)
  return result.stdout.toString().trim()
}

test("external packed preview packages typecheck, bundle and run without workspace source paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mockingbird-preview-consumer-"))
  try {
    const dependencies: Record<string, string> = {}
    for (const relative of [
      "packages/adapters/browser",
      "packages/adapters/preview",
      "packages/ui",
    ]) {
      const cwd = join(root, relative)
      run(["bun", "run", "build"], cwd)
      const packed = run(["bun", "pm", "pack", "--destination", dir, "--quiet"], cwd)
      const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
      dependencies[manifest.name] = `file:${packed.split("\n").at(-1)}`
    }
    for (const name of Object.keys(dependencies)) {
      const tarball = dependencies[name]?.slice("file:".length) ?? ""
      const manifest = JSON.parse(run(["tar", "-xOzf", tarball, "package/package.json"], dir))
      expect(manifest.private).toBeUndefined()
      expect(manifest.publishConfig?.access).toBe("public")
      expect(JSON.stringify(manifest)).not.toContain("workspace:")
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "external-preview-consumer",
        private: true,
        type: "module",
        dependencies: {
          ...dependencies,
          esbuild: "0.28.2",
          typescript: "5.9.3",
          "@types/node": "22.20.1",
        },
      }),
    )
    run(["bun", "install", "--ignore-scripts"], dir)
    writeFileSync(
      join(dir, "entry.js"),
      `
      import { installBrowserRuntime } from '@crvouga/mockingbird-adapter-browser';
      import { mountSystemHarness } from '@crvouga/mockingbird-ui/system';
      import { createPreviewHost, createPreviewClient } from '@crvouga/mockingbird-preview';
      import '@crvouga/mockingbird-ui/reset.css';
      import { writeFileSync, readFileSync } from 'node:fs';
      import { createServer } from 'node:http';
      globalThis.result = (async () => {
        const dispose = installBrowserRuntime();
        writeFileSync('/hello', 'packed');
        const server = createServer((_req, res) => res.end(readFileSync('/hello'))).listen(8451);
        const reply = await (await fetch('http://localhost:8451')).text();
        const preview = createPreviewHost({artifact:'packed-test', boot:({generation}) => ({
          fetch: async () => new Response('generation:' + generation)
        })});
        const channel = new MessageChannel();
        preview.connect(channel.port1);
        const connection = createPreviewClient(channel.port2);
        if (await (await connection.fetch(new Request('http://preview.test/'))).text() !== 'generation:0')
          throw new Error('packed preview bridge failed');
        connection.dispose();
        await preview.reset();
        if (preview.status().generation !== 1) throw new Error('packed preview reset failed');
        await preview.dispose();
        let mounts = 0, disposed = 0, attempts = 0;
        const host = document.body.appendChild(document.createElement('div'));
        const surface = id => ({id, label:id, mount(node) {
          mounts++; node.textContent=id; return () => {disposed++;};
        }});
        const shell = mountSystemHarness(host, [surface('one'), surface('two'), {
          id:'retry', label:'Retry', mount() {
            if (++attempts === 1) throw new Error('first mount fails');
            mounts++; return () => {disposed++;};
          }
        }]);
        await shell.show('one'); await shell.show('two'); await shell.show('one');
        if (mounts !== 2) throw new Error('switching remounted a surface');
        await shell.show('retry');
        const retry = [...host.querySelectorAll('[role=status] button')].find(b => b.textContent === 'Retry');
        if (!retry) throw new Error('failed mount has no retry');
        retry.click(); await shell.show('retry');
        if (attempts !== 2) throw new Error('retry did not mount');
        shell.destroy();
        let finish, signal, lateDisposed = 0;
        const pendingHost = document.body.appendChild(document.createElement('div'));
        const pending = mountSystemHarness(pendingHost, [{id:'slow', label:'Slow', mount(_host, abort) {
          signal = abort; return new Promise(resolve => { finish = resolve; });
        }}]);
        const opening = pending.show('slow');
        await Promise.resolve();
        pending.destroy();
        if (!signal?.aborted) throw new Error('pending mount not aborted');
        finish(() => {lateDisposed++;});
        await opening;
        if (lateDisposed !== 1) throw new Error('late mount leaked');
        server.close(); dispose();
        if (disposed !== 3) throw new Error('surfaces leaked');
        return reply;
      })();
    `,
    )
    writeFileSync(
      join(dir, "build.mjs"),
      `
      import { build } from 'esbuild';
      import { browserRuntimeBuildOptions } from '@crvouga/mockingbird-adapter-browser/build';
      await build({...browserRuntimeBuildOptions(), entryPoints:['entry.js'], bundle:true,
        format:'iife', outfile:'bundle.js'});
    `,
    )
    run(["node", "build.mjs"], dir)
    writeFileSync(
      join(dir, "consumer.ts"),
      `
      import { installBrowserRuntime, UnsupportedRuntimeError } from "@crvouga/mockingbird-adapter-browser"
      import { browserRuntimeBuildOptions } from "@crvouga/mockingbird-adapter-browser/build"
      import { mountSystemHarness, type SystemHarness, type SystemSurface } from "@crvouga/mockingbird-ui/system"
      import { CSS_RESET } from "@crvouga/mockingbird-ui"
      const dispose: () => void = installBrowserRuntime()
      const options = browserRuntimeBuildOptions()
      const surface: SystemSurface = { id: "app", label: "App", mount(host) { host.textContent = CSS_RESET; return () => {} } }
      const harness: SystemHarness = mountSystemHarness(document.body, [surface])
      export { dispose, harness, options, UnsupportedRuntimeError }
    `,
    )
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: ["node"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        files: ["consumer.ts"],
      }),
    )
    run(["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], dir)
    expect(readFileSync(join(dir, "bundle.css"), "utf8")).toContain("box-sizing")
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto("about:blank")
      await page.addScriptTag({ content: readFileSync(join(dir, "bundle.js"), "utf8") })
      expect(await page.evaluate<string>("globalThis.result")).toBe("packed")
    } finally {
      await browser.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
