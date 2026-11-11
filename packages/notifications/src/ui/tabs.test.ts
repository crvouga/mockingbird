import { expect, test } from "bun:test"
import {
  activeTab,
  deviceScale,
  isCompact,
  MIN_SCALE,
  moveTab,
  phoneFit,
  TABS_BELOW_WIDTH,
  tabsFor,
} from "./tabs.js"

test("the devices collapse to tabs below the breakpoint, by the host's width", () => {
  expect(isCompact("auto", TABS_BELOW_WIDTH - 1)).toBe(true)
  expect(isCompact("auto", TABS_BELOW_WIDTH)).toBe(false)
  // Not measured yet (detached, or rendered without layout): stay side by side.
  expect(isCompact("auto", 0)).toBe(false)
  expect(isCompact("tabs", 2000)).toBe(true)
  expect(isCompact("grid", 320)).toBe(false)
})

test("wide has an All tab; narrow has one tab per enabled channel; one channel has none", () => {
  expect(tabsFor(["sms", "push", "email", "chat"], false)).toEqual([
    "all",
    "sms",
    "push",
    "email",
    "chat",
  ])
  expect(tabsFor(["sms", "email"], true)).toEqual(["sms", "email"])
  expect(tabsFor(["push"], false)).toEqual([])
})

test("the selected tab follows the viewer's choice and never lands on a disabled channel", () => {
  const all = ["sms", "push", "email", "chat"] as const
  expect(activeTab(all, false, null, null)).toBe("all")
  expect(activeTab(all, false, "chat", null)).toBe("chat")
  expect(activeTab(all, true, null, null)).toBe("sms")
  expect(activeTab(all, true, null, "email")).toBe("email")
  expect(activeTab(["push", "email"], true, "sms", "chat")).toBe("push")
  expect(activeTab(["email"], false, null, null)).toBe("email")
})

test("arrow keys wrap around the tab list; Home and End jump", () => {
  const tabs = ["all", "sms", "push"] as const
  expect(moveTab(tabs, "all", "ArrowRight")).toBe("sms")
  expect(moveTab(tabs, "push", "ArrowRight")).toBe("all")
  expect(moveTab(tabs, "all", "ArrowLeft")).toBe("push")
  expect(moveTab(tabs, "sms", "Home")).toBe("all")
  expect(moveTab(tabs, "sms", "End")).toBe("push")
  expect(moveTab(tabs, "sms", "Enter")).toBeNull()
  expect(moveTab([], "all", "ArrowRight")).toBeNull()
})

test("scale is 1 unless given, and never below the smallest readable size or above full size", () => {
  expect(deviceScale(undefined)).toBe(1)
  expect(deviceScale(Number.NaN)).toBe(1)
  expect(deviceScale(0.75)).toBe(0.75)
  expect(deviceScale(0.1)).toBe(MIN_SCALE)
  expect(deviceScale(3)).toBe(1)
})

test("smaller devices collapse to tabs later and need less shrinking to fit", () => {
  // Two phones at 75% fit side by side in 700px; at full size they do not.
  expect(isCompact("auto", 700)).toBe(true)
  expect(isCompact("auto", 700, 0.75)).toBe(false)
  expect(isCompact("auto", TABS_BELOW_WIDTH * 0.75 - 1, 0.75)).toBe(true)
  expect(phoneFit(378)).toBe(1)
  expect(phoneFit(300)).toBeCloseTo(284 / 362)
  expect(phoneFit(300, 0.75)).toBe(1)
  expect(phoneFit(100)).toBe(0.5)
})
