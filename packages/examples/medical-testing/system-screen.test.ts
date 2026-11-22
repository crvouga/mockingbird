import { describe, expect, test } from "bun:test"
import type { SystemServices } from "@crvouga/mockingbird-ui"
import { buildDemo } from "./src/composition/build.js"
import { createLabDevResources } from "./src/composition/dev.js"
import {
  API_READY,
  checkStripeKey,
  labBackends,
  labConfiguration,
  STRIPE_KEY_FIELDS,
  startupClock,
  withBrowserKey,
} from "./src/composition/systemScreen.js"

/** #903: the lab's System screen shows a keyed service, start-up timings and a facts section. */

const KEY = "sk_test_51abcdefghij"

/** The lab with no dev proxy, as most static previews run: every service reads unavailable. */
const startLab = async () => {
  const dev = createLabDevResources(undefined)
  const demo = await buildDemo({ html: "", js: "" })
  const inner = dev.controls(demo.admins) as SystemServices
  const services = withBrowserKey(inner, {
    id: "stripe",
    fields: STRIPE_KEY_FIELDS,
    check: checkStripeKey,
  })
  const stripe = async () =>
    (await services.list()).services.find((service) => service.id === "stripe")
  return { demo, inner, services, stripe }
}

describe("Stripe takes a key typed on the System screen", () => {
  test("without a proxy, Stripe has fields and can be switched to Dev", async () => {
    const { inner, services, stripe } = await startLab()
    const before = await stripe()
    expect(before?.fields?.map((field) => field.name)).toEqual(["secretKey", "account"])
    expect(before?.configured).toBe(false)
    expect(before?.unavailable).toBeDefined()
    await expect(inner.setMode("stripe", "dev")).rejects.toThrow()

    await services.setMode("stripe", "dev")
    expect((await stripe())?.mode).toBe("dev")
    expect(await services.test?.("stripe")).toEqual({ ok: false, message: "Save a key first." })

    await services.setCredentials?.("stripe", { secretKey: KEY, account: "sandbox" })
    expect((await stripe())?.configured).toBe(true)
    expect((await services.test?.("stripe"))?.ok).toBe(true)

    await services.clearCredentials?.()
    expect(await stripe()).toMatchObject({ configured: false, mode: "emulated" })
  })

  test("a live key is refused and never kept", async () => {
    const { services, stripe } = await startLab()
    await expect(
      services.setCredentials?.("stripe", { secretKey: "sk_live_abcdefghij", account: "test" }),
    ).rejects.toThrow("live key")
    expect((await stripe())?.configured).toBe(false)
  })

  test("other services are left as the proxy's controls list them", async () => {
    const { inner, services } = await startLab()
    const strip = (list: Awaited<ReturnType<SystemServices["list"]>>) =>
      list.services.filter((service) => service.id !== "stripe")
    expect(strip(await services.list())).toEqual(strip(await inner.list()))
    await expect(services.setMode("resend", "dev")).rejects.toThrow()
    await expect(services.setCredentials?.("resend", { secretKey: KEY })).rejects.toThrow()
  })

  test("a change is announced to the screen", async () => {
    const { services } = await startLab()
    let heard = 0
    const stop = services.subscribe?.(() => heard++)
    await services.setCredentials?.("stripe", { secretKey: KEY, account: "test" })
    await services.setMode("stripe", "dev")
    expect(heard).toBe(2)
    stop?.()
  })
})

describe("start-up timings and configuration", () => {
  test("the Lab API reports when it was ready, and the timeline every step", async () => {
    let now = 1000
    const clock = startupClock(() => now)
    now = 1400
    clock.mark("database and emulators")
    now = 1450
    clock.mark(API_READY)
    now = 1600
    clock.mark("System mounted")
    const backends = labBackends(clock, [{ id: "stripe", label: "Stripe" }])
    const list = await backends.list()
    expect(list[0]).toMatchObject({ id: "lab-api", state: "ready", startedInMs: 450 })
    expect(list[1]).toMatchObject({ id: "stripe", kind: "emulator" })
    expect(list[1]?.startedInMs).toBeUndefined()
    expect(await backends.timeline?.()).toEqual([
      { label: "database and emulators", atMs: 400 },
      { label: API_READY, atMs: 450 },
      { label: "System mounted", atMs: 600 },
    ])
  })

  test("the Configuration section lists the proxy and every service", async () => {
    const groups = await labConfiguration({ keyed: ["stripe"] }).load()
    expect(groups.map((group) => group.group)).toEqual(["Dev resources", "Services"])
    expect(groups[0]?.rows[0]).toMatchObject({ label: "dev-proxy", value: "not set", tone: "off" })
    const postgres = groups[1]?.rows.find((row) => row.label === "postgres")
    expect(postgres).toMatchObject({ value: "emulated only", tone: "off" })
    expect(postgres?.note).toBeDefined()
  })
})
