/**
 * Recorded parity: every scenario in test/scenarios was run against a real, self-hosted
 * Medplum (the oracle, see scripts/parity.ts) and its canonical exchanges committed to
 * test/fixtures/oracle-recording.json. Here each scenario runs against a fresh mock and every
 * exchange must match the oracle's — status, headers and body — without an oracle in CI.
 *
 * Refresh the recording after changing a scenario: `bun run oracle:record`.
 */
import { describe, expect, test } from "bun:test"
import { diff } from "./test/harness/canonical.js"
import { runScenario, type ScenarioRecording } from "./test/harness/scenario.js"
import { mockTarget } from "./test/harness/target.js"
import { scenarios } from "./test/scenarios/index.js"

const recording = (await Bun.file(
  new URL("./test/fixtures/oracle-recording.json", import.meta.url),
).json()) as {
  medplum: string
  recordedAt: string
  scenarios: ScenarioRecording[]
}

// A scenario replays dozens of requests; graphql takes ~1 s alone and far longer on a loaded
// CI runner, past bun's 5 s default.
const SCENARIO_TIMEOUT_MS = 30_000

const recorded = new Map(recording.scenarios.map((scenario) => [scenario.name, scenario]))

describe(`oracle parity (Medplum ${recording.medplum}, recorded ${recording.recordedAt})`, () => {
  test("every scenario has a recording, and every recording a scenario", () => {
    expect([...recorded.keys()].sort()).toEqual(scenarios.map((s) => s.name).sort())
  })

  for (const scenario of scenarios) {
    test(
      scenario.name,
      async () => {
        const expected = recorded.get(scenario.name)
        expect(expected).toBeDefined()
        const actual = await runScenario(
          mockTarget({ baseUrl: "http://mock.medplum.local/" }),
          scenario,
        )
        expect(actual.exchanges.map((e) => e.step)).toEqual(
          expected?.exchanges.map((e) => e.step) ?? [],
        )
        const failures: string[] = []
        actual.exchanges.forEach((entry, index) => {
          const oracle = expected?.exchanges[index]?.exchange
          if (!oracle || !entry.exchange) return
          const differences = diff(oracle, entry.exchange)
          if (differences.length > 0)
            failures.push(`${entry.step}\n  ${differences.slice(0, 8).join("\n  ")}`)
        })
        expect(failures).toEqual([])
      },
      SCENARIO_TIMEOUT_MS,
    )
  }
})
