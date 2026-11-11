import { describe, expect, test } from "bun:test"
import { api, setFetcher } from "./src/client/api.js"
import { buildApp } from "./src/composition/build.js"
import { createInProcessFetcher } from "./src/composition/inProcessFetcher.js"
import { payWithHostedCheckout, signInWithGoogle, waitUntil } from "./testing/inProcessFlow.js"

/**
 * Exercises the exact wiring `composition/browser.ts`'s `mount()` uses
 * (Hono's `app.request()` plus the in-memory session header) through
 * `client/api.ts`'s public `api.*` surface — the same surface the Preact
 * pages call — to prove a browser mount round-trips its session correctly
 * with no socket and no real network call anywhere.
 */
describe("in-process fetcher (browser mount wiring)", () => {
  test("signing in, buying a test, paying, and settling into results on its own", async () => {
    const app = await buildApp({ html: "", js: "" })
    setFetcher(createInProcessFetcher(app))

    expect((await signInWithGoogle()).email).toBe("ada@example.test")

    const { tests } = await api.tests()
    expect(tests.length).toBeGreaterThan(0)
    const testId = tests[0]?.id
    if (!testId) throw new Error("no lab tests seeded")

    const { orderId, checkoutSessionId } = await api.checkout([testId])
    await payWithHostedCheckout(checkoutSessionId)

    await waitUntil(async () => {
      const { orders } = await api.orders()
      const order = orders.find((o) => o.id === orderId)
      return order?.status === "fulfilled" && Boolean(order.labOrderId)
    })

    await waitUntil(async () => {
      const { orders } = await api.orders()
      const order = orders.find((o) => o.id === orderId)
      return order?.status === "results_ready" && Boolean(order.interpretation)
    })
    // The lab adapter holds results for RESULTS_READY_DELAY_MS (4s), so bun's 5s default
    // leaves no room; budget for both waitUntil calls instead.
  }, 20_000)
})
