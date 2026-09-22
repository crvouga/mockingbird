/**
 * Live parity against a real, self-hosted Medplum (the oracle): every scenario, then random
 * walks, each run on the oracle and a fresh mock with every exchange compared. Opt in with
 * `MOCKINGBIRD_MEDPLUM_ORACLE=1` (boots the pinned server on embedded Postgres and Redis; the
 * first run builds it) or point `MOCKINGBIRD_MEDPLUM_ORACLE_URL` at one already running.
 * CI replays the committed recording instead (medplum.oracle-replay.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { type MedplumOracle, startOracle } from "./oracle/index.js"
import { diff } from "./test/harness/canonical.js"
import { runRandomWalks } from "./test/harness/random.js"
import { runScenario } from "./test/harness/scenario.js"
import { mockTarget, type Target } from "./test/harness/target.js"
import { scenarios } from "./test/scenarios/index.js"

const oracleUrl = process.env.MOCKINGBIRD_MEDPLUM_ORACLE_URL
const enabled = process.env.MOCKINGBIRD_MEDPLUM_ORACLE === "1" || Boolean(oracleUrl)
const params = fcParameters(process.env)

describe.skipIf(!enabled)("live oracle parity", () => {
  let booted: MedplumOracle | undefined
  let oracle: Target

  beforeAll(async () => {
    if (oracleUrl) {
      const base = new URL(oracleUrl)
      oracle = {
        name: "oracle",
        baseUrl: base.href,
        fetch: (request) => {
          const url = new URL(request.url)
          const target = new URL(url.pathname + url.search, base)
          return fetch(new Request(target, request))
        },
      }
    } else {
      booted = await startOracle()
      const server = booted
      oracle = {
        name: "oracle",
        baseUrl: server.baseUrl,
        fetch: (request) => server.fetch(request),
      }
    }
  }, 900_000)

  afterAll(async () => {
    await booted?.stop()
  })

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const real = await runScenario(oracle, scenario)
      const fake = await runScenario(
        mockTarget({ baseUrl: "http://mock.medplum.local/" }),
        scenario,
      )
      const failures: string[] = []
      real.exchanges.forEach((entry, index) => {
        const differences = diff(entry.exchange, fake.exchanges[index]?.exchange)
        if (differences.length > 0)
          failures.push(`${entry.step}\n  ${differences.slice(0, 8).join("\n  ")}`)
      })
      expect(failures).toEqual([])
    }, 120_000)
  }

  test("random walks agree", async () => {
    const result = await runRandomWalks({
      oracle,
      mock: () => mockTarget({ baseUrl: "http://mock.medplum.local/" }),
      runs: params.numRuns ?? 10,
      steps: 30,
      seed: params.seed ?? Date.now() % 2 ** 31,
    })
    if (!result.ok) throw new Error(result.report)
  }, 900_000)
})
