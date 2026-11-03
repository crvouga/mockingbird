import { describe, expect, test } from "bun:test"
import { auditTime } from "./src/model.js"

describe("members audit log", () => {
  test("an event without a usable createdAt shows a placeholder, not Invalid Date", () => {
    for (const missing of [undefined, null, ""]) expect(auditTime(missing)).toBe("—")
    expect(auditTime("not a date")).toBe("not a date")
  })

  test("a timestamp is shown in the viewer's locale", () => {
    const at = "2026-03-04T05:06:07.000Z"
    expect(auditTime(at)).toBe(new Date(at).toLocaleString())
    expect(auditTime(Date.parse(at))).toBe(new Date(at).toLocaleString())
  })
})
