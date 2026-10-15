import { describe, expect, test } from "bun:test"
import { alertIfWaiting } from "./attention.ts"

describe("alertIfWaiting", () => {
  test("a step that finishes in time never alerts", async () => {
    const alerts: string[] = []
    const result = await alertIfWaiting("waiting", async () => "done", {
      afterMs: 50,
      everyMs: 50,
      alert: (message) => alerts.push(message),
    })
    await Bun.sleep(80)
    expect(result).toBe("done")
    expect(alerts).toEqual([])
  })

  test("a stalled step alerts repeatedly, and stops once it settles", async () => {
    const alerts: string[] = []
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    await alertIfWaiting("npm login is waiting for you", () => pending, {
      afterMs: 0,
      everyMs: 10,
      alert: (message) => {
        alerts.push(message)
        // Settle after observing repetition, independent of event-loop load.
        if (alerts.length === 2) finish?.()
      },
    })
    const rung = alerts.length
    expect(rung).toBeGreaterThanOrEqual(2)
    expect(alerts[0]).toBe("npm login is waiting for you")
    await Bun.sleep(40)
    expect(alerts.length).toBe(rung)
  })

  test("a failed step still rejects and stops alerting", async () => {
    const alerts: string[] = []
    const failing = alertIfWaiting(
      "waiting",
      async () => {
        await Bun.sleep(20)
        throw new Error("npm exited 1")
      },
      { afterMs: 5, everyMs: 1000, alert: (message) => alerts.push(message) },
    )
    await expect(failing).rejects.toThrow("npm exited 1")
    await Bun.sleep(20)
    expect(alerts).toEqual(["waiting"])
  })
})
