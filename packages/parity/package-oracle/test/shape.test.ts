import { describe, expect, test } from "bun:test"
import { shape } from "./shape.js"

describe("shape", () => {
  test("keeps array length", () => {
    expect(shape({ data: [{ id: "a" }, { id: "b" }] })).not.toEqual(shape({ data: [{ id: "a" }] }))
  })

  test("keeps the order of differently shaped items", () => {
    expect(shape([1, "a"])).not.toEqual(shape(["a", 1]))
  })

  test("reduces leaves to their type and ignores key order", () => {
    expect(shape({ b: 1, a: [null, "x"] })).toEqual(shape({ a: [null, "y"], b: 2 }))
  })
})
