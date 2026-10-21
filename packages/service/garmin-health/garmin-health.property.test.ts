import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, GarminHealthAPI, supportedOperationIds } from "./src/index.js"

const baseUrl = "https://garmin.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Bearer mock_garmin_token" })
test(
  "all Garmin Health operations agree between independent instances",
  async () => {
    const reference = new GarminHealthAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "garmin-health",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["garmin.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new GarminHealthAPI({ now }) },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 40,
      maxCommands: 20,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = new GarminHealthAPI({ now })
    await expect(
      parity({
        provider: "garmin-health",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["garmin.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["GetUserId"],
        numRuns: 5,
        maxCommands: 2,
        latencyToleranceMs: 1000,
        seed: 42,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(ParityError)
  },
  { timeout: 60_000 },
)
