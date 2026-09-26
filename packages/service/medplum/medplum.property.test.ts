/**
 * Properties that hold for any data, checked with fast-check (replay with FC_SEED):
 *
 * - self-parity: the repo's `parity()` walker drives two independent mocks through random
 *   Patient create/read/search/delete/history walks and every answer conforms to the contract;
 * - search laws (metamorphic): comma-OR is the union of its parts, `:missing` partitions,
 *   `:not` complements a token match, `_sort` orders, pages concatenate to the whole, and
 *   `_total` / `_summary=count` count it;
 * - versioning: history and vread reflect every effective write, and a delete tombstones;
 * - transactions (with the `transaction-bundles` feature): an invalid entry rolls back all.
 */
import { describe, expect, test } from "bun:test"
import { parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import type { Bundle, Patient } from "@medplum/fhirtypes"
import fc from "fast-check"
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  document,
  MedplumAPI,
} from "./src/index.js"

const params = fcParameters(process.env)
const BASE = "https://mock.medplum.local/"
const BASIC = `Basic ${btoa(`${DEFAULT_CLIENT_ID}:${DEFAULT_CLIENT_SECRET}`)}`

const call = async (
  api: MedplumAPI,
  method: string,
  path: string,
  body?: unknown,
  type = "application/fhir+json",
) => {
  const response = await api.fetch(
    new Request(`${BASE}${path.replace(/^\//, "")}`, {
      method,
      headers: { authorization: BASIC, ...(body !== undefined ? { "content-type": type } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as any }
}

const ids = (bundle: Bundle | undefined): string[] =>
  (bundle?.entry ?? []).map((e) => e.resource?.id as string)

const FAMILIES = ["Lovelace", "Turing", "Hopper", "Zola", "Ng"]
const patientArb = fc.record(
  {
    gender: fc.constantFrom("male", "female", "other", "unknown"),
    birthDate: fc
      .tuple(
        fc.integer({ min: 1900, max: 2020 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      )
      .map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`),
    family: fc.constantFrom(...FAMILIES),
    mrn: fc.constantFrom("A", "B", "C"),
    active: fc.boolean(),
  },
  { requiredKeys: [] },
)

const toPatient = (p: {
  gender?: string
  birthDate?: string
  family?: string
  mrn?: string
  active?: boolean
}): Patient => ({
  resourceType: "Patient",
  ...(p.gender ? { gender: p.gender as Patient["gender"] } : {}),
  ...(p.birthDate ? { birthDate: p.birthDate } : {}),
  ...(p.family ? { name: [{ family: p.family }] } : {}),
  ...(p.mrn ? { identifier: [{ system: "https://example.org/mrn", value: p.mrn }] } : {}),
  ...(p.active !== undefined ? { active: p.active } : {}),
})

const populate = async (people: Parameters<typeof toPatient>[0][]) => {
  const api = new MedplumAPI({ baseUrl: BASE })
  const created: Patient[] = []
  for (const person of people)
    created.push((await call(api, "POST", "/fhir/R4/Patient", toPatient(person))).body)
  return { api, created }
}

const all = async (api: MedplumAPI, query: string) =>
  (await call(api, "GET", `/fhir/R4/Patient?${query}${query ? "&" : ""}_count=1000`)).body as Bundle

describe("self-parity", () => {
  test("two independent mocks agree on random Patient walks and conform to the contract", async () => {
    // One frozen clock for both, so timestamps agree like the ids do.
    const now = () => 1_700_000_000_000
    const reference = new MedplumAPI({ baseUrl: BASE, now })
    const report = await parity({
      provider: "medplum",
      spec: document,
      real: {
        baseUrl: "https://mock.medplum.local",
        allowedHosts: ["mock.medplum.local"],
        headers: () => ({ authorization: BASIC }),
        fetch: (request) => reference.fetch(request),
      },
      mock: {
        create: () => new MedplumAPI({ baseUrl: BASE, now }),
        baseUrl: "https://mock.medplum.local",
        headers: () => ({ authorization: BASIC }),
      },
      cleanup: async () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 15,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      env: process.env,
      maxCommands: 20,
      latencyToleranceMs: 5_000,
      sleep: async () => {},
      log: () => {},
    })
    expect(report.walks).toBeGreaterThan(0)
    expect(Object.keys(report.exercised).length).toBeGreaterThan(2)
  }, 120_000)
})

describe("search laws", () => {
  test("a comma-separated value is the union of its parts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(patientArb, { maxLength: 12 }),
        fc.constantFrom(...FAMILIES),
        fc.constantFrom(...FAMILIES),
        async (people, a, b) => {
          const { api } = await populate(people)
          const union = new Set([
            ...ids(await all(api, `family=${a}`)),
            ...ids(await all(api, `family=${b}`)),
          ])
          expect(new Set(ids(await all(api, `family=${a},${b}`)))).toEqual(union)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  }, 120_000)

  test(":missing partitions every parameter type, and :not complements a token match", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(patientArb, { maxLength: 12 }), async (people) => {
        const { api, created } = await populate(people)
        const everyone = new Set(created.map((p) => p.id as string))
        // Column-indexed parameters only: on the server, `:missing` against a lookup-table
        // parameter (name, family, address) matches nothing either way, and the mock agrees.
        for (const code of ["gender", "birthdate", "identifier", "active"]) {
          const missing = ids(await all(api, `${code}:missing=true`))
          const present = ids(await all(api, `${code}:missing=false`))
          expect(missing.filter((id) => present.includes(id))).toEqual([])
          expect(new Set([...missing, ...present])).toEqual(everyone)
        }
        const matched = new Set(ids(await all(api, "identifier=https://example.org/mrn|A")))
        const complement = new Set(ids(await all(api, "identifier:not=https://example.org/mrn|A")))
        expect(new Set([...matched, ...complement])).toEqual(everyone)
        expect([...matched].filter((id) => complement.has(id))).toEqual([])
      }),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 120_000)

  test("_sort orders by the value, with missing values last ascending and first descending", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(patientArb, { maxLength: 12 }), async (people) => {
        const { api } = await populate(people)
        const ascending = ((await all(api, "_sort=birthdate")).entry ?? []).map(
          (e) => (e.resource as Patient).birthDate,
        )
        const defined = ascending.filter((d) => d !== undefined) as string[]
        expect(defined).toEqual([...defined].sort())
        expect(ascending.slice(defined.length).every((d) => d === undefined)).toBe(true)
        const descending = ((await all(api, "_sort=-birthdate")).entry ?? []).map(
          (e) => (e.resource as Patient).birthDate,
        )
        const missingFirst = descending.filter((d) => d === undefined).length
        expect(descending.slice(0, missingFirst).every((d) => d === undefined)).toBe(true)
        expect(descending.slice(missingFirst)).toEqual([...defined].sort().reverse())
      }),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 120_000)

  test("pages concatenate to the whole result, and _total and _summary=count count it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(patientArb, { maxLength: 14 }),
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom("", "gender=female", "active=true"),
        async (people, size, filter) => {
          const { api } = await populate(people)
          const prefix = filter ? `${filter}&` : ""
          const whole = ids(await all(api, `${prefix}_sort=_lastUpdated`))
          const paged: string[] = []
          for (let offset = 0; offset <= whole.length; offset += size) {
            const page = (
              await call(
                api,
                "GET",
                `/fhir/R4/Patient?${prefix}_sort=_lastUpdated&_count=${size}&_offset=${offset}`,
              )
            ).body as Bundle
            paged.push(...ids(page))
            const next = page.link?.some((l) => l.relation === "next")
            expect(next).toBe(offset + size < whole.length)
          }
          expect(paged).toEqual(whole)
          expect(
            (await call(api, "GET", `/fhir/R4/Patient?${prefix}_total=accurate&_count=1`)).body
              .total,
          ).toBe(whole.length)
          expect(
            (await call(api, "GET", `/fhir/R4/Patient?${prefix}_summary=count`)).body.total,
          ).toBe(whole.length)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 120_000)

  test("cursor paging on _lastUpdated walks every result exactly once", async () => {
    const { api, created } = await populate(
      Array.from({ length: 45 }, (_, i) => ({ family: `F${i}` })),
    )
    const seen: string[] = []
    let path: string | undefined = "/fhir/R4/Patient?_sort=_lastUpdated&_count=20"
    while (path) {
      const page = (await call(api, "GET", path)).body as Bundle
      seen.push(...ids(page))
      const next = page.link?.find((l) => l.relation === "next")?.url
      path = next ? new URL(next).pathname + new URL(next).search : undefined
      if (next) expect(next).toContain("_cursor=")
    }
    expect(seen).toEqual(created.map((p) => p.id as string))
  })
})

describe("versioning", () => {
  test("history and vread reflect every effective write; a delete tombstones and 410s", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.option(patientArb, { nil: undefined }), { minLength: 1, maxLength: 6 }),
        async (writes) => {
          const api = new MedplumAPI({ baseUrl: BASE })
          const first = (await call(api, "POST", "/fhir/R4/Patient", { resourceType: "Patient" }))
            .body as Patient
          const versions = [first]
          for (const write of writes) {
            if (write === undefined) {
              // An update that changes nothing is not a new version.
              const same = (
                await call(api, "PUT", `/fhir/R4/Patient/${first.id}`, {
                  ...versions.at(-1),
                  meta: undefined,
                })
              ).body as Patient
              expect(same.meta?.versionId).toBe(versions.at(-1)?.meta?.versionId)
              continue
            }
            const next = (
              await call(api, "PUT", `/fhir/R4/Patient/${first.id}`, {
                ...toPatient(write),
                id: first.id,
              })
            ).body as Patient
            if (next.meta?.versionId !== versions.at(-1)?.meta?.versionId) versions.push(next)
          }
          const history = (await call(api, "GET", `/fhir/R4/Patient/${first.id}/_history`))
            .body as Bundle
          expect(history.total).toBe(versions.length)
          expect(history.entry?.map((e) => e.resource?.meta?.versionId)).toEqual(
            versions.map((v) => v.meta?.versionId).reverse(),
          )
          for (const version of versions) {
            const read = await call(
              api,
              "GET",
              `/fhir/R4/Patient/${first.id}/_history/${version.meta?.versionId}`,
            )
            expect(read.body).toEqual(version)
          }
          expect((await call(api, "DELETE", `/fhir/R4/Patient/${first.id}`)).status).toBe(200)
          expect((await call(api, "GET", `/fhir/R4/Patient/${first.id}`)).status).toBe(410)
          const after = (await call(api, "GET", `/fhir/R4/Patient/${first.id}/_history`))
            .body as Bundle
          expect(after.total).toBe(versions.length + 1)
          expect(after.entry?.[0]?.request?.method).toBe("DELETE")
        },
      ),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  }, 120_000)
})

describe("transactions", () => {
  test("with transaction-bundles, one invalid entry rolls back every entry", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(patientArb, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        async (people, where) => {
          const api = new MedplumAPI({ baseUrl: BASE })
          await api.putResource({
            resourceType: "Project",
            id: DEFAULT_PROJECT_ID,
            name: "Mockingbird",
            strictMode: true,
            features: ["transaction-bundles"],
          } as never)
          const entries = people.map((p) => ({
            request: { method: "POST", url: "Patient" },
            resource: toPatient(p),
          }))
          entries.splice(where % (entries.length + 1), 0, {
            request: { method: "POST", url: "Patient" },
            resource: { resourceType: "Patient", birthDate: "not a date" } as Patient,
          })
          const response = await call(api, "POST", "/fhir/R4", {
            resourceType: "Bundle",
            type: "transaction",
            entry: entries,
          })
          expect(response.status).toBe(400)
          expect(
            (await call(api, "GET", "/fhir/R4/Patient?_total=accurate&_count=0")).body.total,
          ).toBe(0)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 15 },
    )
  }, 120_000)
})
