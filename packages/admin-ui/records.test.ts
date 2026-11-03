import { describe, expect, test } from "bun:test"
import { recordRow } from "./src/model.js"

describe("state record rows", () => {
  test("the id column is the record id, even when the value has its own id", () => {
    const row = recordRow({ id: "cus_1", value: { id: "external-42", name: "Ada" } })
    expect(row.id).toBe("cus_1")
    expect(row["value.id"]).toBe("external-42")
    expect(row.name).toBe("Ada")
  })

  test("values without an id and non-object values are unchanged", () => {
    expect(recordRow({ id: "a", value: { name: "Ada" } })).toEqual({ id: "a", name: "Ada" })
    expect(recordRow({ id: "b", value: 7 })).toEqual({ id: "b", value: 7 })
  })
})
