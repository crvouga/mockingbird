import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chromium } from "@playwright/test"
import { build } from "esbuild"
import { browserRuntimeBuildOptions } from "./src/build.js"

test("browser runs Node core libraries and Node/Bun/Deno servers in one world", async () => {
  const result = await build({
    ...browserRuntimeBuildOptions(),
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
        import assert from "node:assert";
        import { file as bunFile } from "bun";
        import { readFileSync } from "node:fs";
        import { writeFile } from "node:fs/promises";
        import path from "node:path";
        import { EventEmitter } from "node:events";
        import { createHash, randomUUID, webcrypto } from "node:crypto";
        import { gzipSync, gunzipSync } from "node:zlib";
        import { createServer } from "node:http";
        import { installBrowserRuntime, browserRuntime } from "./src/index.ts";
        globalThis.result = (async () => {
          const dispose = installBrowserRuntime();
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(Buffer.from("hello").toString("base64"), "aGVsbG8=");
          await writeFile("/file.txt", "hello");
          assert.equal(await Deno.readTextFile("/file.txt"), "hello");
          assert.equal(await Bun.file("/file.txt").text(), "hello");
          assert.equal(await bunFile("/file.txt").text(), "hello");
          assert.equal(Deno.statSync("/file.txt").isFile, true);
          assert.equal(Deno.readTextFileSync("/file.txt"), "hello");
          assert.equal(readFileSync("/file.txt", "utf8"), "hello");
          assert.equal(path.join("/a", "b", "..", "c"), "/a/c");
          assert.equal(createHash("sha256").update("abc").digest("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
          assert.equal(gunzipSync(gzipSync(Buffer.from("data"))).toString(), "data");
          assert.match(randomUUID(), /^[a-f0-9-]{36}$/);
          assert.equal((await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"))).byteLength, 32);
          const events = new EventEmitter(); let count = 0;
          events.on("event", () => count++); events.emit("event"); assert.equal(count, 1);
          process.env.PUBLIC = "configured"; assert.equal(Deno.env.get("PUBLIC"), "configured");
          const bun = Bun.serve({ port: 8801, fetch: () => new Response("bun") });
          const deno = Deno.serve({ port: 8802 }, () => new Response("deno"));
          const node = createServer((req, res) => {
            res.setHeader("content-type", "text/plain");
            let body = "";
            req.on("data", chunk => { body += chunk.toString(); });
            req.on("end", () => res.end(req.method + ":" + req.url + body));
          }).listen(8803);
          assert.equal(await (await fetch("http://localhost:8801")).text(), "bun");
          assert.equal(await (await fetch("http://localhost:8802")).text(), "deno");
          assert.equal(await (await fetch("http://localhost:8803/hello?x=1")).text(), "GET:/hello?x=1");
          assert.equal(await (await fetch("http://localhost:8803/echo", { method: "POST", body: "payload" })).text(), "POST:/echopayload");
          bun.stop(); await deno.shutdown(); node.close();
          await assert.rejects(fetch("http://localhost:8803"), /no browser-local server/);
          assert.equal("SECRET_FROM_BUILD_MACHINE" in process.env, false);
          dispose();
          return "passed";
        })();
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    logLevel: "silent",
  })
  if (!existsSync(chromium.executablePath())) {
    const install = Bun.spawnSync(
      ["bunx", "playwright", "install", ...(process.env.CI ? ["--with-deps"] : []), "chromium"],
      { cwd: import.meta.dir, stdout: "ignore", stderr: "inherit" },
    )
    if (install.exitCode !== 0) throw new Error("Chromium installation failed")
  }
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.route("https://runtime.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Runtime contract</title>",
      }),
    )
    await page.goto("https://runtime.test/")
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(await page.evaluate<string>("globalThis.result")).toBe("passed")
  } finally {
    await browser.close()
  }
}, 120_000)

test("unsupported native imports fail at build time instead of becoming empty mocks", async () => {
  for (const name of ["node:net", "node:child_process", "bun:sqlite", "node:unknown"]) {
    await expect(
      build({
        ...browserRuntimeBuildOptions(),
        stdin: {
          contents: `import * as api from "${name}"; console.log(api)`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
        logLevel: "silent",
      }),
    ).rejects.toThrow()
  }
})
