import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import {
  DEFAULT_ACCESS_TOKEN,
  document,
  type SeedWorkout,
  SuuntoAPI,
  type SuuntoAPIOptions,
  supportedOperationIds,
} from "./src/index.js"

const baseUrl = "https://suunto.test",
  now = () => Date.UTC(2026, 8, 20),
  headers = () => ({ authorization: `Bearer ${DEFAULT_ACCESS_TOKEN}` })
const T0 = Date.UTC(2026, 8, 1),
  DAY = 86_400_000
const workout = (workoutId: number, day: number): SeedWorkout => ({
  workoutId,
  activityId: 3,
  startTime: T0 + day * DAY,
  stopTime: T0 + day * DAY + 3_600_000,
  totalTime: 3600,
})
// The consent redirect carries one-time codes only the acceptance tests can redeem.
const browserOnly = ["Authorize"]
const seeds: SuuntoAPIOptions = {
  now,
  workouts: [workout(1001, 1), workout(1002, 5), workout(1003, 9)],
  sleepSamples: [{ timestamp: T0 + 2 * DAY, entryData: { Duration: 27000 } }],
  activitySamples: [{ timestamp: T0 + 2 * DAY, entryData: { HR: 58 } }],
  dailyStatistics: [{ name: "stepcount", time: "2026-09-02T00:00:00+00:00", value: 8000 }],
}
const create = () => new SuuntoAPI(seeds)
test(
  "all Suunto operations agree between independent instances",
  async () => {
    const reference = create(),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "suunto",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["suunto.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 40,
      maxCommands: 20,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised).sort()).toEqual(
      supportedOperationIds.filter((id) => !browserOnly.includes(id)).sort(),
    )
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = create()
    await expect(
      parity({
        provider: "suunto",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["suunto.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["ListWorkouts"],
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
