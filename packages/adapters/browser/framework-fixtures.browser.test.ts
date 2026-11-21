import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { build } from "esbuild"
import { browserRuntimeBuildOptions } from "./src/build.js"

const require = createRequire(import.meta.url)
const adapter = (name: string) => join(import.meta.dir, "src/network", `${name}.ts`)

test("Fastify serves a real route through the browser runtime", async () => {
  const result = await build({
    ...browserRuntimeBuildOptions({
      virtualNetwork: true,
      asyncContext: "zone",
      adapters: {
        http2: join(import.meta.dir, "src/http2-unsupported.ts"),
        dns: adapter("dns"),
        tls: adapter("tls"),
        diagnostics_channel: adapter("diagnostics-channel"),
        pino: createRequire(require.resolve("fastify")).resolve("pino/browser.js"),
      },
    }),
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
      import Fastify from "fastify";
      import { browserRuntime } from "./src/index.ts";
      globalThis.result = (async () => {
        globalThis.phase = "creating"; const app = Fastify({logger:false});
        app.addHook("onRequest", async () => { globalThis.phase = "onRequest"; });
        app.addHook("preHandler", async () => { globalThis.phase = "preHandler"; });
        app.addHook("onSend", async (_request, _reply, payload) => { globalThis.phase = "onSend"; return payload; });
        app.addHook("onError", async (_request, _reply, error) => { globalThis.phase = "error:" + error.message; });
        app.get("/hello", async () => { globalThis.phase = "handler"; return {message:"hello"}; });
        globalThis.phase = "listening"; await app.listen({port:8805, host:"localhost"});
        globalThis.phase = "fetch";
        const response = await browserRuntime.fetch("http://localhost:8805/hello");
        globalThis.phase = "body"; const body = await response.json(); globalThis.phase = "close"; await app.close(); return body;
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
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(errors).toEqual([])
    expect(
      await page.evaluate<unknown>(
        "Promise.race([globalThis.result, new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out at ' + globalThis.phase)), 5000))])",
      ),
    ).toEqual({ message: "hello" })
  } finally {
    await browser.close()
  }
}, 30_000)

test("Next request/response APIs serve React streamed SSR with isolated request context", async () => {
  const result = await build({
    ...browserRuntimeBuildOptions({
      asyncContext: "zone",
      sourceRoot: join(import.meta.dir, "../../.."),
    }),
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
      import { NextRequest, NextResponse } from "next/server";
      import React from "react";
      import { renderToReadableStream } from "react-dom/server.browser";
      import { AsyncLocalStorage } from "node:async_hooks";
      const store = new AsyncLocalStorage();
      const render = async name => store.run(name, async () => {
        const request = new NextRequest("https://preview.test/?name=" + name);
        await new Promise(resolve => setTimeout(resolve, name === "first" ? 10 : 1));
        const body = await renderToReadableStream(React.createElement("h1", null, request.nextUrl.searchParams.get("name") + ":" + store.getStore()));
        return new NextResponse(body, { headers: { "content-type": "text/html" } }).text();
      });
      globalThis.result = Promise.all([render("first"), render("second")]);
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
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(errors).toEqual([])
    expect(await page.evaluate<unknown>("globalThis.result")).toEqual([
      "<h1>first:first</h1>",
      "<h1>second:second</h1>",
    ])
  } finally {
    await browser.close()
  }
}, 30_000)

test("Nest dependency injection and decorated controller run through Fastify", async () => {
  const result = await build({
    ...browserRuntimeBuildOptions({
      virtualNetwork: true,
      asyncContext: "zone",
      optionalModules: [
        "class-validator",
        "class-transformer",
        "@nestjs/websockets/socket-module",
        "@nestjs/microservices/microservices-module",
        "@nestjs/microservices",
        "@fastify/static",
        "@fastify/view",
        "@nestjs/platform-express",
        "repl",
      ],
      sourceRoot: join(import.meta.dir, "../../.."),
      adapters: {
        http2: join(import.meta.dir, "src/http2-unsupported.ts"),
        dns: adapter("dns"),
        tls: adapter("tls"),
        diagnostics_channel: adapter("diagnostics-channel"),
        pino: createRequire(require.resolve("fastify")).resolve("pino/browser.js"),
      },
    }),
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
      import "reflect-metadata";
      import { NestFactory } from "@nestjs/core";
      import { Controller, Get, Module, Injectable, Inject } from "@nestjs/common";
      import { FastifyAdapter } from "@nestjs/platform-fastify";
      import { browserRuntime } from "./src/index.ts";
      class GreetingService { greeting() { return "from Nest"; } }
      Injectable()(GreetingService);
      class GreetingController { constructor(service) { this.service = service; } hello() { return {message:this.service.greeting()}; } }
      Inject(GreetingService)(GreetingController, undefined, 0);
      Controller()(GreetingController);
      Get("hello")(GreetingController.prototype, "hello", Object.getOwnPropertyDescriptor(GreetingController.prototype, "hello"));
      class AppModule {}
      Module({controllers:[GreetingController],providers:[GreetingService]})(AppModule);
      globalThis.result = (async () => {
        globalThis.phase = "creating";
        const app = await NestFactory.create(AppModule, new FastifyAdapter({logger:false}), {logger:false,abortOnError:false});
        globalThis.phase = "listen"; await app.listen(8806,"127.0.0.1");
        globalThis.phase = "fetch"; const response = await browserRuntime.fetch("http://localhost:8806/hello");
        globalThis.phase = "body"; const body = await response.json(); globalThis.phase = "close"; await app.close(); return body;
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
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(errors).toEqual([])
    expect(
      await page.evaluate<unknown>(
        "Promise.race([globalThis.result,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Timed out at '+globalThis.phase)),5000))])",
      ),
    ).toEqual({ message: "from Nest" })
  } finally {
    await browser.close()
  }
}, 30_000)
