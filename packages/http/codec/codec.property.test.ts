import { expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  decodeBody,
  decodeForm,
  encodeBody,
  encodeForm,
  type FormObject,
  mediaTypeOf,
} from "./src/index.js"

const params = fcParameters(process.env)

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
