import { describe, expect, test } from "bun:test"
import { notEmulated, trackServices } from "./src/system-services-store.ts"
import type { SystemService, SystemServiceMode, SystemServices } from "./src/system-types.ts"

function fake() {
  const modes = new Map<string, SystemServiceMode>([
    ["stripe", "emulated"],
    ["twilio", "emulated"],
  ])
  const listeners = new Set<() => void>()
  let lists = 0
  const services: SystemServices = {
    async list() {
      lists++
      return {
        dev: { state: "ready", message: "ok" },
        services: [...modes].map(([id, mode]): SystemService => ({ id, label: id, mode })),
      }
    },
    async setMode(id, mode) {
      modes.set(id, mode)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    services,
    modes,
    lists: () => lists,
    /** Another tab changed a mode. */
    elsewhere(id: string, mode: SystemServiceMode) {
      modes.set(id, mode)
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("trackServices (#871)", () => {
  test("the pill's list follows a switch on the System screen", async () => {
    const host = fake()
    const store = trackServices(host.services)
    await store.refresh()
    expect(notEmulated(store.latest())).toEqual([])
    let seen = 0
    const stop = store.watch(() => seen++)
    await store.services.setMode("stripe", "dev")
    expect(notEmulated(store.latest()).map((service) => service.id)).toEqual(["stripe"])
    expect(seen).toBeGreaterThan(0)
    stop()
  })

  test("a change the host reports (another tab) lists again and reaches the pill", async () => {
    const host = fake()
    const store = trackServices(host.services)
    await store.refresh()
    const stop = store.watch(() => {})
    host.elsewhere("twilio", "dev")
    await settle()
    expect(notEmulated(store.latest()).map((service) => service.id)).toEqual(["twilio"])
    stop()
    expect(host.listeners.size).toBe(0)
  })

  test("the screen's subscribe hears the host and the screen's own switches", async () => {
    const host = fake()
    const store = trackServices(host.services)
    let heard = 0
    const stop = store.services.subscribe(() => heard++)
    host.elsewhere("stripe", "dev")
    await store.services.setMode("twilio", "dev")
    expect(heard).toBe(2)
    stop()
    expect(host.listeners.size).toBe(0)
  })

  test("lists on their way at the same time are shared", async () => {
    const host = fake()
    const store = trackServices(host.services)
    await Promise.all([store.services.list(), store.services.list(), store.refresh()])
    expect(host.lists()).toBe(1)
  })

  test("test is offered only when the host has one", async () => {
    expect(trackServices(fake().services).services.test).toBeUndefined()
    const host = fake()
    const store = trackServices({ ...host.services, test: async (id) => ({ ok: id === "stripe" }) })
    expect(await store.services.test?.("stripe")).toEqual({ ok: true })
  })
})
