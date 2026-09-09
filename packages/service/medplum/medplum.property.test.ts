import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { buildServerConfig, type MedplumServerConfig } from "./src/config.js"
import { createMedplumAPI, type MedplumAPI } from "./src/index.js"
import { resolveMedplumPaths } from "./src/paths.js"

const E2E_ENABLED = process.env.MOCKINGBIRD_MEDPLUM_E2E === "1"
const describeE2E = E2E_ENABLED ? describe : describe.skip
const params = fcParameters(process.env)
void params

const assertConfigShape = (
  config: MedplumServerConfig,
  input: { apiPort: number; dbPort: number; redisPort: number; dataDir: string },
): void => {
  expect(config.port).toBe(input.apiPort)
  expect(config.baseUrl).toBe(`http://127.0.0.1:${input.apiPort}/`)
  expect(config.database.port).toBe(input.dbPort)
  expect(config.redis.port).toBe(input.redisPort)
  expect(config.binaryStorage.startsWith(`file:${input.dataDir}`)).toBe(true)
  expect(config.emailProvider).toBe("none")
  expect(config.rateLimitsEnabled).toBe(false)
  expect(config.vmContextBotsEnabled).toBe(true)
  expect((config.defaultSuperAdminEmail?.length ?? 0) > 0).toBe(true)
  expect((config.defaultSuperAdminPassword?.length ?? 0) > 0).toBe(true)
  expect((config.defaultSuperAdminClientId?.length ?? 0) > 0).toBe(true)
  expect((config.defaultSuperAdminClientSecret?.length ?? 0) > 0).toBe(true)
  JSON.parse(JSON.stringify(config))
}

const fastConfigArbitrary = fc.record({
  apiPort: fc.integer({ min: 1024, max: 65535 }),
  dbPort: fc.integer({ min: 1024, max: 65535 }),
  redisPort: fc.integer({ min: 1024, max: 65535 }),
  dataDir: fc
    .tuple(fc.constant("/tmp/medplum-mock-test-"), fc.integer({ min: 0, max: 999999 }))
    .map(([prefix, index]) => `${prefix}${index}`),
})

describe("config properties", () => {
  test("generated server config embeds the given ports and local-only defaults", () => {
    fc.assert(
      fc.property(fastConfigArbitrary, (input) => {
        assertConfigShape(buildServerConfig(input), input)
      }),
      { numRuns: 100 },
    )
  })

  test("resolves a stable cache layout", () => {
    const paths = resolveMedplumPaths({ version: "5.1.37", cacheDir: "/tmp/mock-cache" })
    expect(paths.version).toBe("v5.1.37")
    expect(paths.cloneDir).toBe("/tmp/mock-cache/v5.1.37")
    expect(paths.serverEntry.endsWith("/packages/server/dist/index.js")).toBe(true)
  })
})

describeE2E("medplum self-hosted properties", () => {
  let primary: MedplumAPI

  const createPatient = async (api: MedplumAPI, family: string): Promise<Response> => {
    const token = await api.getAccessToken()
    const base = api.getBaseUrl().replace(/\/+$/, "")
    return api.fetch(
      new Request(new URL("/fhir/R4/Patient", base), {
        method: "POST",
        headers: { "content-type": "application/fhir+json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ resourceType: "Patient", name: [{ family }] }),
      }),
    )
  }

  const countPatients = async (api: MedplumAPI): Promise<number> => {
    const token = await api.getAccessToken()
    const base = api.getBaseUrl().replace(/\/+$/, "")
    const response = await api.fetch(
      new Request(new URL("/fhir/R4/Patient?_count=100&_total=accurate", base), {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    if (!response.ok) throw new Error(`patient search failed with ${response.status}`)
    const bundle = (await response.json()) as { total?: number }
    return bundle.total ?? 0
  }

  beforeAll(async () => {
    primary = await createMedplumAPI()
  }, 900_000)

  afterAll(async () => {
    await primary?.stop()
  }, 120_000)

  test(
    "every random walk sees exactly the patients it created, on a healthy server",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (patients) => {
          await primary.reset()
          for (let index = 0; index < patients; index += 1) {
            const response = await createPatient(primary, `Family${index}`)
            expect(response.status).toBe(201)
          }
          expect(await countPatients(primary)).toBe(patients)
          expect(primary.isStarted).toBe(true)
        }),
        { numRuns: 3, timeout: 600_000 },
      )
    },
    { timeout: 1_800_000 },
  )

  test(
    "reset() drops every resource written by the previous walk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (patients) => {
          await primary.reset()
          for (let index = 0; index < patients; index += 1) {
            await createPatient(primary, `Family${index}`)
          }
          await primary.reset()
          expect(await countPatients(primary)).toBe(0)
        }),
        { numRuns: 2, timeout: 600_000 },
      )
    },
    { timeout: 1_200_000 },
  )

  test(
    "boots two independent servers with distinct ports and isolated data",
    async () => {
      const secondary = await createMedplumAPI()
      try {
        expect(secondary.getBaseUrl()).not.toBe(primary.getBaseUrl())
        await createPatient(secondary, "OnlyOnSecondary")
        expect(await countPatients(primary)).toBe(0)
        expect(await countPatients(secondary)).toBe(1)
      } finally {
        await secondary.stop()
      }
    },
    { timeout: 600_000 },
  )

  test(
    "stop() tears down and restart resumes on a fresh port",
    async () => {
      const restartable = await createMedplumAPI()
      try {
        await createPatient(restartable, "Persist")
        const port = restartable.apiPort
        await restartable.stop()
        expect(restartable.isStarted).toBe(false)
        const revived = await createMedplumAPI()
        try {
          expect(revived.apiPort).not.toBe(port)
          expect(await countPatients(revived)).toBe(0)
        } finally {
          await revived.stop()
        }
      } finally {
        await restartable.stop()
      }
    },
    { timeout: 600_000 },
  )
})
