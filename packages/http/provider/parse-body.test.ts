import { describe, expect, test } from "bun:test"
import { HonoRequest } from "./src/vendor/core/http.js"

type Fields = Promise<Record<string, unknown>>
// Index by a string so TypeScript does not type `constructor` as Object's own member.
const field = (body: Record<string, unknown>, name: string) => body[name]

const form = (body: string): Fields =>
  new HonoRequest(
    new Request("http://vendor.local/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    {},
  ).parseBody()

const multipart = (fields: [string, string][]): Fields => {
  const data = new FormData()
  for (const [key, value] of fields) data.append(key, value)
  return new HonoRequest(
    new Request("http://vendor.local/", { method: "POST", body: data }),
    {},
  ).parseBody()
}

describe("parseBody field names", () => {
  for (const [label, parse] of [
    ["urlencoded", (fields: [string, string][]) => form(new URLSearchParams(fields).toString())],
    ["multipart", multipart],
  ] as const) {
    test(`${label}: names that shadow Object.prototype are plain fields`, async () => {
      const body = await parse([
        ["constructor", "a"],
        ["toString", "b"],
        ["hasOwnProperty", "c"],
      ])
      expect(field(body, "constructor")).toBe("a")
      expect(field(body, "toString")).toBe("b")
      expect(field(body, "hasOwnProperty")).toBe("c")
    })

    test(`${label}: __proto__ is a field, not the body's prototype`, async () => {
      const body = await parse([
        ["__proto__", "x"],
        ["name", "n"],
      ])
      // Before the fix, `target["__proto__"] = [Object.prototype, "x"]` swapped in an array prototype.
      expect(Array.isArray(Object.getPrototypeOf(body))).toBe(false)
      expect(Object.hasOwn(body, "__proto__")).toBe(true)
      expect(Object.getOwnPropertyDescriptor(body, "__proto__")?.value).toBe("x")
      expect(field(body, "name")).toBe("n")
    })

    test(`${label}: a field missing from the body reads as undefined`, async () => {
      const body = await parse([["name", "n"]])
      expect(field(body, "constructor")).toBeUndefined()
      expect(field(body, "toString")).toBeUndefined()
    })
  }
})
