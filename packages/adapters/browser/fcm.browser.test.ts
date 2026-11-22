import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { build } from "esbuild"
import { browserRuntimeBuildOptions } from "./src/build.js"

const fcmDir = join(import.meta.dir, "../../service/fcm")
const require = createRequire(join(fcmDir, "package.json"))

for (const sdk of ["firebase-admin", "firebase-admin-12"] as const)
  test(`${sdk} sends and legacy multicast reach the emulator through browser Fetch`, async () => {
    const runtimeOptions = browserRuntimeBuildOptions({
      virtualNetwork: true,
      asyncContext: "zone",
      adapters: {
        child_process: join(import.meta.dir, "src/child-process-unsupported.ts"),
        https: join(import.meta.dir, "src/http-client.ts"),
        http: join(import.meta.dir, "src/http-client.ts"),
        http2: join(import.meta.dir, "src/http2-unsupported.ts"),
        tls: join(import.meta.dir, "src/network/tls.ts"),
        dns: join(import.meta.dir, "src/network/dns.ts"),
        diagnostics_channel: join(import.meta.dir, "src/network/diagnostics-channel.ts"),
      },
    })
    const result = await build({
      ...runtimeOptions,
      stdin: {
        resolveDir: fcmDir,
        contents: `
    import { initializeApp, deleteApp } from ${JSON.stringify(require.resolve(`${sdk}/app`))};
    import { getMessaging } from ${JSON.stringify(require.resolve(`${sdk}/messaging`))};
    import { createRuntime, FCM_FIXTURE_PROJECT, FCM_FIXTURE_TOKEN } from "./src/index.ts";
    import { createAdminCredential, routeAdminRequest } from "./src/admin-fetch.ts";
    globalThis.result = (async () => {
      const runtime = createRuntime();
      const route = routeAdminRequest(runtime);
      globalThis.fetch = (input, init) => route(new Request(input, init)) ?? Promise.reject(new Error("Unexpected external request"));
      const credential = createAdminCredential();
      await runtime.fetch(new Request("http://fcm/__admin/settings", {method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({strict:true,credentials:{"fixture-token":{project:FCM_FIXTURE_PROJECT}}})}));
      const app = initializeApp({projectId:FCM_FIXTURE_PROJECT, credential}, "browser-sdk");
      try {
        const messaging = getMessaging(app); messaging.enableLegacyHttpTransport();
        const id = await messaging.send({token:FCM_FIXTURE_TOKEN, notification:{title:"Browser fixture"}});
        const batch = await messaging.sendEachForMulticast({tokens:[FCM_FIXTURE_TOKEN,FCM_FIXTURE_TOKEN],notification:{title:"Browser batch"}});
        const outbox = await (await runtime.fetch(new Request("http://fcm/__admin/outbox"))).json();
        return {id, success:batch.successCount, failed:batch.failureCount, messages:outbox.messages.length};
      } finally { await deleteApp(app); }
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
      await page.route("https://fcm.test/**", (route) =>
        route.fulfill({ body: "<!doctype html>", contentType: "text/html" }),
      )
      await page.goto("https://fcm.test/")
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
      await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
      expect(errors).toEqual([])
      const answer = await page.evaluate<{
        id: string
        success: number
        failed: number
        messages: number
      }>("globalThis.result")
      expect(answer.id).toStartWith("projects/")
      expect(answer).toMatchObject({ success: 2, failed: 0, messages: 3 })
    } finally {
      await browser.close()
    }
  }, 60_000)
