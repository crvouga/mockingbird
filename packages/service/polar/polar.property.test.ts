import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, PolarAPI, supportedOperationIds } from "./src/index.js"

const baseUrl = "https://polar.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Bearer mock_polar_token" })
test(
  "all Polar operations agree between independent instances",
  async () => {
    const reference = new PolarAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "polar",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["polar.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new PolarAPI({ now }) },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 40,
      maxCommands: 20,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    // The consent page is a browser redirect flow (parity disabled); acceptance tests cover it.
    expect(Object.keys(report.exercised).sort()).toEqual(
      supportedOperationIds.filter((id) => id !== "Authorize").sort(),
    )
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = new PolarAPI({ now })
    await expect(
      parity({
        provider: "polar",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["polar.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["ListExercises"],
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
