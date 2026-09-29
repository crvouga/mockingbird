import { expect, test } from "bun:test"
import fixture from "./evidence/fingerprint-python.json" with { type: "json" }
import { canonicalFingerprintInput, sha256 } from "./src/fingerprint.js"

test("canonical bytes and SHA256 match independent Python stdlib reference vectors", async () => {
  for (const vector of fixture.vectors) {
    const canonical = canonicalFingerprintInput(vector.raw, vector.memoryKey)
    expect(canonical).toBe(vector.canonical)
    expect(await sha256(canonical)).toBe(vector.sha256)
  }
})

test("lone surrogates are explicitly unsupported instead of silently replaced in UTF8", () => {
  expect(() => canonicalFingerprintInput('{"input":"\\ud800"}', "")).toThrow(
    "lone Unicode surrogates",
  )
})
