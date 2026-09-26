/**
 * The embedded FHIR definitions: they come from the same `@medplum/definitions` release as
 * `@medplum/core`, and every SearchParameter of every resource type they define runs through
 * the search engine — as a filter (`:missing`) and as a sort — without a server error.
 */
import { describe, expect, test } from "bun:test"
import { getSearchParameters, globalSchema, isResourceType } from "@medplum/core"
import {
  DEFINITIONS_VERSION,
  MedplumAPI,
  SUPER_ADMIN_CLIENT_ID,
  SUPER_ADMIN_CLIENT_SECRET,
} from "./src/index.js"
import { ensureSchema } from "./src/schema.js"

const BASE = "http://localhost:8103/"
const BASIC = `Basic ${btoa(`${SUPER_ADMIN_CLIENT_ID}:${SUPER_ADMIN_CLIENT_SECRET}`)}`

const versionOf = async (name: string): Promise<string> =>
  (
    (await Bun.file(Bun.resolveSync(`${name}/package.json`, import.meta.dir)).json()) as {
      version: string
    }
  ).version

describe("definitions", () => {
  test("match the @medplum/core release the mock is built on", async () => {
    expect(DEFINITIONS_VERSION).toBe(await versionOf("@medplum/definitions"))
    expect(DEFINITIONS_VERSION).toBe(await versionOf("@medplum/core"))
  })

  test("every search parameter of every resource type filters and sorts without a server error", async () => {
    await ensureSchema()
    const api = new MedplumAPI({ baseUrl: BASE })
    const types = Object.keys(globalSchema.types).filter((type) => isResourceType(type))
    expect(types.length).toBeGreaterThan(140)
    const failures: string[] = []
    let checked = 0
    for (const type of types) {
      for (const code of Object.keys(getSearchParameters(type) ?? {})) {
        for (const query of [`${code}:missing=true`, `_sort=${code}`]) {
          const response = await api.fetch(
            new Request(`${BASE}fhir/R4/${type}?${query}&_count=1`, {
              headers: { authorization: BASIC },
            }),
          )
          checked++
          if (response.status >= 500)
            failures.push(`${type}?${query}: ${response.status} ${await response.text()}`)
          else await response.body?.cancel()
        }
      }
    }
    expect(checked).toBeGreaterThan(2000)
    expect(failures).toEqual([])
  }, 300_000)
})
