import { expect, test } from "bun:test"
import { createNotificationHarness } from "@crvouga/mockingbird-notifications"
import { createRuntime as fcm } from "@crvouga/mockingbird-service-fcm"
import { createRuntime as resend } from "@crvouga/mockingbird-service-resend"
import { createRuntime as slack } from "@crvouga/mockingbird-service-slack"
import { createRuntime as twilio } from "@crvouga/mockingbird-service-twilio"
import {
  CHECKOUT_STEPS,
  createNotificationsDemo,
  DEMO_ACTIONS,
  DEMO_CUSTOMER,
} from "../src/client/notificationsDemo/actions.ts"
import { deviceLayout, GRID_WIDTH, TABS_BELOW } from "../src/client/notificationsDemo/layout.ts"

const boot = () => {
  const runtimes = { twilio: twilio(), resend: resend(), fcm: fcm(), slack: slack() }
  return {
    demo: createNotificationsDemo(runtimes),
    harness: createNotificationHarness({ services: runtimes, pollIntervalMs: 0 }),
  }
}

test("every button's call is accepted by its emulator and read back by the harness", async () => {
  const { demo, harness } = boot()
  try {
    for (const action of DEMO_ACTIONS) {
      const before = await harness.list()
      const call = await demo.send(action)
      expect(call.status).toBeLessThan(300)
      expect(call.path).not.toContain("000000")
      const added = (await harness.list()).filter((n) => !before.some((b) => b.id === n.id))
      expect(added.map((n) => [n.channel, n.service])).toEqual([[call.channel, call.service]])
    }
    const whatsapp = (await harness.list()).find((n) => n.sms?.via === "whatsapp")
    expect(whatsapp?.to).toBe(DEMO_CUSTOMER.phone)
  } finally {
    harness.close()
  }
})

test("a checkout sends one message per device about one order, and repeats differ", async () => {
  const { demo, harness } = boot()
  try {
    const previews: string[][] = []
    for (let run = 0; run < 2; run++) {
      const before = await harness.list()
      const order = demo.nextOrder()
      for (const step of CHECKOUT_STEPS) await demo.send(step.action, order)
      const added = (await harness.list()).filter((n) => !before.some((b) => b.id === n.id))
      expect(added.map((n) => n.channel).sort()).toEqual(["chat", "email", "push", "sms"])
      const numbers = new Set(added.map((n) => /#(\d+)/.exec(n.email?.subject ?? n.preview)?.[1]))
      expect(numbers.size).toBe(1)
      previews.push(added.map((n) => n.preview))
    }
    expect(previews[0]).not.toEqual(previews[1])
  } finally {
    harness.close()
  }
})

test("reset empties every emulator, and the demo sends again afterwards", async () => {
  const { demo, harness } = boot()
  try {
    for (const action of DEMO_ACTIONS) await demo.send(action)
    expect((await harness.list()).length).toBe(DEMO_ACTIONS.length)
    await demo.reset()
    expect(await harness.list()).toEqual([])
    // FCM forgot the device with everything else; the next push registers it again.
    expect((await demo.send("push")).status).toBe(200)
    expect((await harness.list()).map((n) => n.channel)).toEqual(["push"])
  } finally {
    harness.close()
  }
})

test("the devices sit side by side when four fit, and one at a time below that", () => {
  expect(deviceLayout(1232)).toEqual({ layout: "grid", scale: 0.736 })
  // Four devices at this scale never need more room than the stage has.
  for (let width = TABS_BELOW; width < 2400; width += 7) {
    const { layout, scale } = deviceLayout(width)
    expect(layout).toBe("grid")
    expect(scale).toBeLessThanOrEqual(0.8)
    if (scale < 0.8) expect(GRID_WIDTH * scale).toBeLessThanOrEqual(width)
  }
  expect(deviceLayout(TABS_BELOW - 1)).toEqual({ layout: "tabs", scale: 0.8 })
  expect(deviceLayout(358)).toEqual({ layout: "tabs", scale: 0.72 })
})
