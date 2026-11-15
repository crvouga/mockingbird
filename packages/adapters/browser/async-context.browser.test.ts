import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { build } from "esbuild"
import { browserRuntimeBuildOptions } from "./src/build.js"

test("lowered async functions preserve concurrent contexts, callbacks and teardown in Chromium", async () => {
  const result = await build({
    ...browserRuntimeBuildOptions({ asyncContext: "zone" }),
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
      import assert from "node:assert";
      import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
      const storage = new AsyncLocalStorage();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      globalThis.result = (async () => {
        const tasks = ["a", "b"].map((id, index) => storage.run(id, async () => {
          assert.equal(storage.getStore(), id);
          await delay(index ? 1 : 10);
          assert.equal(storage.getStore(), id);
          await Promise.resolve().then(() => assert.equal(storage.getStore(), id));
          await storage.run(id + "-nested", async () => {
            await delay(1); assert.equal(storage.getStore(), id + "-nested");
            await storage.exit(async () => { await delay(1); assert.equal(storage.getStore(), undefined); });
            assert.equal(storage.getStore(), id + "-nested");
          });
          assert.equal(storage.getStore(), id);
          try { await storage.run("error", async () => { await delay(1); throw new Error("expected"); }); } catch {}
          assert.equal(storage.getStore(), id);
          const resource = new AsyncResource("fixture");
          const bound = storage.constructor.bind(() => storage.getStore());
          const snapshot = storage.constructor.snapshot();
          await storage.exit(async () => {
            assert.equal(bound(), id); assert.equal(snapshot(() => storage.getStore()), id);
            assert.equal(resource.runInAsyncScope(() => storage.getStore()), id);
          });
          resource.emitDestroy();
          assert.throws(() => resource.runInAsyncScope(() => {}), /destroyed/);
          return id;
        }));
        assert.deepEqual(await Promise.all(tasks), ["a", "b"]);
        assert.equal(storage.getStore(), undefined);
        const disabled = new AsyncLocalStorage();
        await disabled.run("old", async () => { disabled.disable(); await delay(1); assert.equal(disabled.getStore(), undefined); });
        assert.throws(() => storage.enterWith("unsafe"), /not implemented/);
        return "passed";
      })();
    `,
    },
    bundle: true,
    write: false,
    format: "iife",
    logLevel: "silent",
  })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(await page.evaluate<string>("globalThis.result")).toBe("passed")
  } finally {
    await browser.close()
  }
}, 30_000)

test("context mode refuses builds that can retain uninstrumented native async functions", async () => {
  for (const overrides of [
    { supported: { "async-await": true } },
    { external: ["external-context"] },
  ]) {
    await expect(
      build({
        ...browserRuntimeBuildOptions({ asyncContext: "zone" }),
        ...overrides,
        stdin: { contents: "export const value = 1", resolveDir: import.meta.dir },
        bundle: true,
        write: false,
        logLevel: "silent",
      }),
    ).rejects.toThrow("Zone async context")
  }
})
