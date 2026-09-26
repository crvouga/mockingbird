import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { CredentialError, createRedactor, leaks, loadCredentials } from "./src/index.js"

const params = fcParameters(process.env)

const secret = fc.stringMatching(/^[A-Za-z0-9_-]{4,40}$/)
const slug = fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/)

describe("env credentials", () => {
  test("every field present in the env resolves, and nothing secret survives redaction", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          provider: slug,
          fieldA: slug,
          fieldB: slug,
          valueA: secret,
          valueB: secret,
          noise: fc.string({ maxLength: 40 }),
        }),
        async (input) => {
          fc.pre(input.fieldA !== input.fieldB)
          fc.pre(input.valueA !== input.valueB)
          const spec = {
            provider: input.provider,
            fields: {
              [input.fieldA]: `${input.provider.toUpperCase()}_A`,
              [input.fieldB]: `${input.provider.toUpperCase()}_B`,
            },
          }
          const env: Record<string, string | undefined> = {
            [spec.fields[input.fieldA] ?? ""]: input.valueA,
            [spec.fields[input.fieldB] ?? ""]: input.valueB,
          }

          const loaded = await loadCredentials(spec, { env })
          expect(loaded.values).toEqual({
            [input.fieldA]: input.valueA,
            [input.fieldB]: input.valueB,
          })
          expect(loaded.secrets).toContain(input.valueA)
          expect(loaded.secrets).toContain(input.valueB)

          const redact = createRedactor(loaded.secrets)
          const leaky = `${input.noise}${input.valueA} ${input.valueB}${input.noise}`
          const clean = redact(leaky)
          expect(leaks(clean, loaded.secrets)).toBe(false)
          expect(leaks(leaky, loaded.secrets)).toBe(true)
        },
      ),
      params,
    )
  })

  test("a missing field surfaces a typed error naming the provider and every env var", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          provider: slug,
          fieldA: slug,
          fieldB: slug,
          valueA: secret,
          missingB: fc.boolean(),
        }),
        async (input) => {
          fc.pre(input.fieldA !== input.fieldB)
          const envVarA = `${input.provider.toUpperCase()}_A`
          const envVarB = `${input.provider.toUpperCase()}_B`
          const spec = {
            provider: input.provider,
            fields: { [input.fieldA]: envVarA, [input.fieldB]: envVarB },
          }
          const env: Record<string, string | undefined> = { [envVarA]: input.valueA }

          const outcome = await loadCredentials(spec, { env }).then(
            () => "ok",
            (error: unknown) => error,
          )
          expect(outcome).toBeInstanceOf(CredentialError)
          const message = (outcome as CredentialError).message
          expect(message).toContain(input.provider)
          expect(message).toContain(envVarA)
          expect(message).toContain(envVarB)
        },
      ),
      params,
    )
  })
})
