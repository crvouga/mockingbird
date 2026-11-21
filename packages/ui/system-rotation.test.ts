import { expect, test } from "bun:test"
import {
  ORDER_KEY,
  ROTATION_KEY,
  readExcluded,
  readOrder,
  reconcileOrder,
  stepRotation,
  summarizeServices,
  writeExcluded,
  writeOrder,
} from "./src/system-rotation.js"

const memory = (initial?: string) => {
  const values = new Map<string, string>(initial === undefined ? [] : [[ROTATION_KEY, initial]])
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test("the arrows skip excluded surfaces and always keep System", () => {
  const order = ["system", "app", "emulators", "notifications"]
  const none = new Set<string>()
  expect(stepRotation(order, none, "system", 1)).toBe("app")
  expect(stepRotation(order, none, "system", -1)).toBe("notifications")
  const skip = new Set(["emulators"])
  expect(stepRotation(order, skip, "app", 1)).toBe("notifications")
  expect(stepRotation(order, skip, "notifications", -1)).toBe("app")
  // An excluded surface opened by URL still steps from its own place.
  expect(stepRotation(order, skip, "emulators", 1)).toBe("notifications")
  expect(stepRotation(order, skip, "emulators", -1)).toBe("app")
  const all = new Set(["app", "emulators", "notifications", "system"])
  expect(stepRotation(order, all, "app", 1)).toBe("system")
  expect(stepRotation(order, all, "system", 1)).toBe("system")
  expect(stepRotation(order, none, "unknown", 1)).toBe("app")
})

test("rotation survives storage round trips and ignores junk", () => {
  const store = memory()
  writeExcluded(() => store, new Set(["b", "a"]))
  expect(store.getItem(ROTATION_KEY)).toBe('["a","b"]')
  expect([...readExcluded(() => store)]).toEqual(["a", "b"])
  expect(readExcluded(() => memory("not json")).size).toBe(0)
  expect(readExcluded(() => memory('{"a":1}')).size).toBe(0)
  expect([...readExcluded(() => memory('["system",1,"x"]'))]).toEqual(["x"])
  const broken = () => {
    throw new Error("SecurityError")
  }
  expect(readExcluded(broken).size).toBe(0)
  expect(() => writeExcluded(broken, new Set(["a"]))).not.toThrow()
})

test("the services summary counts each mode", () => {
  expect(summarizeServices([{ mode: "emulated" }, { mode: "sandbox" }, { mode: "emulated" }])).toBe(
    "3 services · 2 emulated · 1 sandbox",
  )
  expect(summarizeServices([{ mode: "emulated" }])).toBe("1 service · 1 emulated · 0 sandbox")
})

test("a saved order survives apps being added and removed", () => {
  const ids = ["system", "app", "emulators", "notifications"]
  expect(reconcileOrder(["notifications", "system", "app", "emulators"], ids)).toEqual([
    "notifications",
    "system",
    "app",
    "emulators",
  ])
  // A removed app is dropped, a new one keeps its default place after its default predecessor.
  expect(reconcileOrder(["emulators", "gone", "system", "app"], ids)).toEqual([
    "emulators",
    "notifications",
    "system",
    "app",
  ])
  expect(reconcileOrder([3, null, "app", "app"], ids)).toEqual([
    "system",
    "app",
    "emulators",
    "notifications",
  ])
})

test("the order is read back from storage, and bad storage means the default order", () => {
  const values = new Map<string, string>()
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
  const ids = ["system", "app", "emulators"]
  expect(readOrder(() => store, ids)).toEqual(ids)
  writeOrder(() => store, ["emulators", "system", "app"])
  expect(JSON.parse(values.get(ORDER_KEY) ?? "")).toEqual(["emulators", "system", "app"])
  expect(readOrder(() => store, ids)).toEqual(["emulators", "system", "app"])
  values.set(ORDER_KEY, "{not json")
  expect(readOrder(() => store, ids)).toEqual(ids)
  const broken = () => {
    throw new Error("storage is disabled")
  }
  expect(readOrder(broken, ids)).toEqual(ids)
  expect(() => writeOrder(broken, ids)).not.toThrow()
})
