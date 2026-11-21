import { expect, test } from "bun:test"
import { createPreviewHost } from "./src/host.js"

test("failed teardown refuses requests and a later reset retries cleanup before booting", async () => {
  let boots = 0
  let attempts = 0
  const host = createPreviewHost({
    artifact: "cleanup-contract",
    boot: () => {
      boots++
      return {
        fetch: () => new Response("ready"),
        dispose: () => {
          if (++attempts === 1) throw new Error("cleanup failed")
        },
      }
    },
  })
  await host.ready()
  await expect(host.reset()).rejects.toThrow("cleanup failed")
  expect(host.status().state).toBe("failed")
  expect((await host.fetch(new Request("http://app/"))).status).toBe(503)
  expect(boots).toBe(1)
  await host.reset()
  expect(attempts).toBe(2)
  expect(boots).toBe(2)
  expect(await (await host.fetch(new Request("http://app/"))).text()).toBe("ready")
  await host.dispose()
})
