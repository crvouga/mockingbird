import { expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  decodeBody,
  decodeForm,
  decodeFormPairs,
  encodeBody,
  encodeForm,
  type FormObject,
  mediaTypeOf,
  readBody,
} from "./src/index.js"

const params = fcParameters(process.env)

test("readBody preserves automatically generated form content types", async () => {
  const request = new Request("http://localhost/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: "synthetic-client", scope: "offline read:sleep" }),
  })
  // Do not access headers first: Bun materializes automatic headers lazily.
  expect(await readBody(request)).toEqual({
    kind: "form",
    value: { client_id: "synthetic-client", scope: "offline read:sleep" },
  })
})

const key = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,7}$/)

/** Values a bracket parser can represent losslessly: strings, non-empty arrays, non-empty objects. */
const formValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { arbitrary: fc.string(), weight: 4 },
    { arbitrary: fc.array(tie("value"), { minLength: 1, maxLength: 3 }), weight: 1 },
    { arbitrary: fc.dictionary(key, tie("value"), { minKeys: 1, maxKeys: 3 }), weight: 1 },
  ),
})).value

const formObject = fc.dictionary(key, formValue, { minKeys: 0, maxKeys: 4 })

test("form encoding round-trips nested objects, arrays and unicode", () => {
  fc.assert(
    fc.property(formObject, (value) => {
      expect(decodeForm(encodeForm(value))).toEqual(value as FormObject)
    }),
    params,
  )
})

/** Bracket paths that would traverse the prototype chain if segments were read unguarded. */
const dangerousKey = fc
  .tuple(
    fc.constantFrom("a", "__proto__", "constructor", "prototype", "hasOwnProperty"),
    fc.array(fc.constantFrom("__proto__", "constructor", "prototype", "0", "1", "polluted"), {
      maxLength: 3,
    }),
  )
  .map(([head, rest]) =>
    [head, ...rest].map((segment, index) => (index === 0 ? segment : `[${segment}]`)).join(""),
  )

test("bracket keys never reach the prototype chain", () => {
  const objectKeys = Object.getOwnPropertyNames(Object.prototype)
  const arrayKeys = Object.getOwnPropertyNames(Array.prototype)
  fc.assert(
    fc.property(
      fc.array(fc.tuple(dangerousKey, fc.string()), { minLength: 1, maxLength: 5 }),
      (pairs) => {
        const decoded = decodeFormPairs(pairs)
        expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
        expect(([] as unknown[])[0]).toBeUndefined()
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      },
    ),
    params,
  )
  expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(objectKeys)
  expect(Object.getOwnPropertyNames(Array.prototype)).toEqual(arrayKeys)
})

test("decodeBody(encodeBody(json)) is identity for JSON values", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const encoded = encodeBody("application/json", value)
      const decoded = decodeBody(encoded.contentType, new TextEncoder().encode(encoded.body))
      // JSON has no distinct -0; stringify/parse collapse it to +0.
      expect(decoded).toEqual({ kind: "json", value: JSON.parse(JSON.stringify(value)) })
    }),
    params,
  )
})

test("mediaTypeOf ignores parameters and case", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("application/json", "text/plain", "application/x-www-form-urlencoded"),
      fc.string().filter((s) => !s.includes(";")),
      (type, param) => {
        expect(mediaTypeOf(`${type.toUpperCase()}; charset=${param}`)).toBe(type)
      },
    ),
    params,
  )
})

test("malformed JSON never throws", () => {
  fc.assert(
    fc.property(fc.uint8Array(), (bytes) => {
      const decoded = decodeBody("application/json", bytes)
      expect(["json", "invalid", "empty"]).toContain(decoded.kind)
    }),
    params,
  )
})

test("sparse bracket indices densify in index order", () => {
  expect(decodeForm("a[3]=d&a[1]=b&a[0]=a&a[2]=c")).toEqual({ a: ["a", "b", "c", "d"] })
  expect(decodeForm("items[7][name]=y&items[2][name]=x")).toEqual({
    items: [{ name: "x" }, { name: "y" }],
  })
})

test("a huge bracket index costs one entry, not one per skipped slot", () => {
  // The largest array index: densifying by walking `length` would visit ~4.3 billion holes.
  const started = performance.now()
  expect(decodeForm("a[4294967294]=x&b[0][99999999]=y")).toEqual({ a: ["x"], b: [["y"]] })
  expect(performance.now() - started).toBeLessThan(1000)
}, 5_000)
