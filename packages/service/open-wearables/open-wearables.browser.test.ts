import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { createRuntime } from "./src/index.js"

test.each(["default", "branch"])(
  "served pairing pages connect after Chromium consent in %s",
  async (namespace) => {
    const runtime = createRuntime()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/done"
          ? new Response("<h1>Back in the app</h1>", { headers: { "content-type": "text/html" } })
          : runtime.fetch(request),
    })
    const origin = server.url.origin
    const response = await fetch(`${origin}/api/v1/users`, {
      method: "POST",
      headers: {
        "X-Open-Wearables-API-Key": "open_wearables_test",
        "content-type": "application/json",
        "x-mockingbird-namespace": namespace,
      },
      body: JSON.stringify({ external_user_id: "browser-fixture" }),
    })
    const user = await response.json()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(3000)
      await page.goto(
        `${origin}${namespace === "default" ? "" : `/__admin/ns/${namespace}`}/users/${user.id}/pair?redirect_url=${encodeURIComponent(`${origin}/done`)}`,
      )
      await page.screenshot({ path: "/tmp/wearables-pairing.png", fullPage: true })
      await page.getByRole("link", { name: "Garmin", exact: true }).click()
      expect(runtime.instance(namespace).state.connections.list()).toEqual([])
      await page.screenshot({ path: "/tmp/wearables-consent.png", fullPage: true })
      await page.getByRole("button", { name: "Allow connection", exact: true }).click()
      await page.getByRole("heading", { name: "Back in the app" }).waitFor()
      expect(runtime.instance(namespace).state.connections.list()[0]?.value).toMatchObject({
        provider: "garmin",
        status: "active",
        user_id: user.id,
      })
    } finally {
      await browser.close()
      await server.stop(true)
    }
  },
  15000,
)
