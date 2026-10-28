/**
 * MinIO parity, offline: every oracle scenario replayed against the emulator must reproduce the
 * transcript MinIO produced (oracle/golden/, refreshed with `bun oracle/run.ts --record`).
 */
import { describe, expect, test } from "bun:test"
import { startEmulator } from "./oracle/emulator.js"
import { readGolden } from "./oracle/golden.js"
import { play } from "./oracle/harness.js"
import { loadScenarios } from "./oracle/scenarios/index.js"

const scenarios = await loadScenarios()

describe("MinIO oracle transcripts", () => {
  for (const scenario of scenarios) {
    const run = scenario.skip ? test.skip : test
    run(
      scenario.name,
      async () => {
        const golden = readGolden(scenario.name)
        expect(
          golden,
          `no golden for ${scenario.name}; run bun oracle/run.ts --record`,
        ).toBeDefined()
        const emulator = await startEmulator()
        try {
          expect(await play(scenario, { target: emulator.target, run: "replay00" })).toEqual(
            golden ?? [],
          )
        } finally {
          await emulator.close()
        }
        // Multipart scenarios move several 5 MiB parts through the emulator.
      },
      60_000,
    )
  }
})
