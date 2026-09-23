/**
 * Parity against a real, self-hosted Medplum (the oracle): boots the pinned server on
 * embedded Postgres and Redis (building it from source on the first run), then
 *
 *   1. runs every scenario in test/scenarios against the oracle and a fresh mock and compares
 *      each canonical exchange (`--record` also rewrites test/fixtures/oracle-recording.json,
 *      which `bun test` replays against the mock without an oracle);
 *   2. runs seeded random differential walks (test/harness/random.ts) — random resources,
 *      searches, updates, patches and deletes — against both.
 *
 *   bun run parity                        # scenarios + random walks
 *   bun run parity -- --record            # also refresh the committed recording
 *   bun run parity -- --oracle-url <url>  # reuse a running oracle
 *   bun run parity -- --runs 20 --steps 40 --seed 7
 *   bun run parity -- --filter search     # scenarios whose name includes "search"
 */
import { writeFile } from "node:fs/promises"
import { MEDPLUM_VERSION } from "@medplum/core"
import { startOracle } from "../oracle/index.js"
import { diff } from "../test/harness/canonical.js"
import { runRandomWalks } from "../test/harness/random.js"
import { runScenario, type ScenarioRecording } from "../test/harness/scenario.js"
import { mockTarget, type Target } from "../test/harness/target.js"
import { scenarios } from "../test/scenarios/index.js"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const record = args.includes("--record")
const filter = flag("--filter")
const oracleUrl = flag("--oracle-url")
const runs = Number(flag("--runs") ?? process.env.FC_NUM_RUNS ?? 12)
const steps = Number(flag("--steps") ?? process.env.MOCKINGBIRD_MAX_COMMANDS ?? 30)
const seed = Number(flag("--seed") ?? process.env.FC_SEED ?? Date.now() % 0x7fffffff)

let stop = async () => {}
let oracle: Target
if (oracleUrl) {
  oracle = {
    name: "oracle",
    baseUrl: oracleUrl.endsWith("/") ? oracleUrl : `${oracleUrl}/`,
    fetch: (request) => {
      const url = new URL(request.url)
      const target = new URL(oracleUrl)
      target.pathname = url.pathname
      target.search = url.search
      return fetch(new Request(target, request))
    },
  }
} else {
  console.log("booting the self-hosted Medplum oracle (the first run builds it from source)…")
  const booted = await startOracle({
    onLog: (line) => {
      if (/\[medplum-mock\]|error/i.test(line)) console.log(line.slice(0, 300))
    },
  })
  oracle = { name: "oracle", baseUrl: booted.baseUrl, fetch: (request) => booted.fetch(request) }
  stop = () => booted.stop()
}

let failures = 0
try {
  // 1. Scenarios, step by step.
  const recordings: ScenarioRecording[] = []
  let compared = 0
  for (const scenario of scenarios.filter((s) => !filter || s.name.includes(filter))) {
    const real = await runScenario(oracle, scenario)
    const fake = await runScenario(mockTarget({ baseUrl: "http://mock.medplum.local/" }), scenario)
    recordings.push(real)
    real.exchanges.forEach((entry, index) => {
      if (!entry.exchange) return
      compared++
      const differences = diff(entry.exchange, fake.exchanges[index]?.exchange)
      if (differences.length > 0) {
        failures++
        console.log(`✗ ${scenario.name} › ${entry.step}`)
        for (const line of differences.slice(0, 12)) console.log(`    ${line}`)
      }
    })
  }
  console.log(`scenarios: ${compared - failures}/${compared} exchanges agree`)
  if (record && !filter) {
    const file = new URL("../test/fixtures/oracle-recording.json", import.meta.url)
    await writeFile(
      file,
      `${JSON.stringify({ medplum: MEDPLUM_VERSION, recordedAt: new Date().toISOString().slice(0, 10), scenarios: recordings }, null, 1)}\n`,
    )
    console.log(`recorded ${recordings.length} scenarios to ${file.pathname}`)
  }

  // 2. Random differential walks.
  if (!filter) {
    const result = await runRandomWalks({
      oracle,
      mock: () => mockTarget({ baseUrl: "http://mock.medplum.local/" }),
      runs,
      steps,
      seed,
      log: (line) => console.log(line),
    })
    if (!result.ok) {
      failures++
      console.log(result.report)
    }
  }
} finally {
  await stop()
}

if (failures > 0) {
  console.error(`\n✗ medplum parity FAILED (${failures})`)
  process.exit(1)
}
console.log("\n✓ medplum parity: the mock matches the self-hosted server")
