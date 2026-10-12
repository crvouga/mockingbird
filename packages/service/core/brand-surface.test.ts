import { expect, test } from "bun:test"
import { createClock } from "./src/clock.js"
import { ADMIN_KEY_HEADER, createControlPlane, NAMESPACE_HEADER } from "./src/control.js"
import { createJournal } from "./src/journal.js"
import { createMetrics } from "./src/metrics.js"
import { MOCKINGBIRD_HEADER } from "./src/runtime.js"

test("admin clock rejects a non-object body with the Mockingbird error", async () => {
  expect(NAMESPACE_HEADER).toBe("x-mockingbird-namespace")
  expect(ADMIN_KEY_HEADER).toBe("x-mockingbird-admin-key")
  expect(MOCKINGBIRD_HEADER).toBe("x-mockingbird")

  const plane = createControlPlane({
    name: "brand",
    startedAt: 0,
    wallNow: () => 0,
    clock: createClock(() => 0),
    metrics: createMetrics(),
    journal: createJournal(),
    defaultNamespace: "default",
    namespaces: () => ["default"],
    reset: async () => {},
    timeTravel: {
      checkpoint: () => ({ id: "c", branch: "main", parent: null, at: 0 }),
      branch: () => ({ id: "c", branch: "main", parent: null, at: 0 }),
      checkout: () => {},
      retain: () => {},
      release: () => true,
      inspect: () => ({ branches: {}, checkpoints: [] }),
    },
    describe: () => ({}),
    routes: {},
    adminKey: undefined,
  })
  const response = await plane.handle(
    new Request("http://mock.local/__admin/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    }),
  )
  expect(response?.status).toBe(400)
  expect(await response?.json()).toEqual({
    error: { type: "mockingbird_admin", message: "expected a JSON object" },
  })
})
