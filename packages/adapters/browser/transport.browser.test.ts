import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { build } from "esbuild"
import { browserRuntimeBuildOptions } from "./src/build.js"

test("real pg, ioredis and Express execute on browser-local transports", async () => {
  const options = browserRuntimeBuildOptions({
    virtualNetwork: true,
    asyncContext: "zone",
    adapters: Object.fromEntries(
      ["tls", "dns", "diagnostics_channel"].map((name) => [
        name,
        `${import.meta.dir}/src/network/${name.replace("_", "-")}.ts`,
      ]),
    ),
  })
  const result = await build({
    ...options,
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
        import { Client } from "pg";
        import Redis from "ioredis";
        import express from "express";
        import { createServer } from "node:net";
        import { createWireServer } from "../../service/postgres/src/wire/transport.ts";
        import { createRedis } from "../../service/redis/src/engine.ts";
        import { createRespServer } from "../../service/redis/src/transport.ts";
        import { installBrowserRuntime } from "./src/index.ts";
        globalThis.result = (async () => {
          const dispose = installBrowserRuntime();
          globalThis.phase = "wire";
          const postgres = await createWireServer();
          const pgServer = createServer(socket => { void postgres.accept(socket); }).listen(5432);
          const redis = createRespServer(createRedis());
          const redisServer = createServer(socket => { void redis.accept(socket); }).listen(6379);
          const client = new Client({ host: "localhost", port: 5432, user: "test", database: "postgres", ssl: false });
          const cache = new Redis({ host: "localhost", port: 6379, lazyConnect: true, retryStrategy: null });
          try {
            globalThis.phase = "pg-connect"; await client.connect();
            globalThis.phase = "pg-query"; const query = await client.query("SELECT 42 AS answer");
            globalThis.phase = "redis-connect"; await cache.connect();
            globalThis.phase = "redis-set"; await cache.set("key", "value");
            const value = await cache.get("key");
            globalThis.phase = "express"; const app = express();
            app.get("/events", (_req, res) => {
              res.setHeader("content-type", "text/event-stream");
              res.flushHeaders();
              res.write("data: first\\n\\n");
            });
            const server = app.listen(8080);
            globalThis.phase = "http-fetch"; const response = await fetch("http://localhost:8080/events");
            const reader = response.body.getReader();
            const first = new TextDecoder().decode((await reader.read()).value);
            await reader.cancel();
            server.close();
            return { answer: query.rows[0].answer, value, first };
          } finally {
            globalThis.phase = "pg-end"; await client.end(); cache.disconnect();
            pgServer.close(); redisServer.close();
            await postgres.close(); await redis.close(); dispose();
          }
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
    await page.route("https://transport.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Transport contract</title>",
      }),
    )
    await page.goto("https://transport.test/")
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(
      await page.evaluate<unknown>(
        "Promise.race([globalThis.result, new Promise((_, reject) => setTimeout(() => reject(new Error(globalThis.phase)), 15000))])",
      ),
    ).toEqual({
      answer: 42,
      value: "value",
      first: "data: first\n\n",
    })
  } finally {
    await browser.close()
  }
}, 120_000)
