/**
 * The MinIO oracle.
 *
 *   bun oracle/run.ts                 # MinIO vs emulator, live, every scenario
 *   bun oracle/run.ts --record        # refresh golden/ from MinIO
 *   bun oracle/run.ts --golden        # emulator vs golden/ (what `bun test` checks)
 *   bun oracle/run.ts basics/ list    # only scenarios whose name contains a filter
 *   bun oracle/run.ts --show basics/x # print the transcripts side by side
 *
 * MinIO comes from S3_ORACLE_ENDPOINT / S3_ORACLE_ACCESS_KEY / S3_ORACLE_SECRET_KEY (default
 * http://127.0.0.1:9000, mockingbird / mockingbird-secret); see oracle/README.md. Exit 0 on
 * parity, 1 on a divergence, 2 when MinIO is unreachable.
 */

import { oracleTarget, startEmulator } from "./emulator.js"
import { readGolden, writeGolden } from "./golden.js"
import { diff, play, type Transcript } from "./harness.js"
import { loadScenarios } from "./scenarios/index.js"

const args = process.argv.slice(2).filter((arg) => arg !== "--")
const flags = new Set(args.filter((arg) => arg.startsWith("--")))
const filters = args.filter((arg) => !arg.startsWith("--"))
const record = flags.has("--record")
const golden = flags.has("--golden")
const show = flags.has("--show")
const runId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0")

const scenarios = (await loadScenarios()).filter(
  (scenario) => !filters.length || filters.some((filter) => scenario.name.includes(filter)),
)
const oracle = oracleTarget()
if (!golden) {
  const live = await fetch(`${oracle.endpoint}/minio/health/live`).catch(() => undefined)
  if (!live?.ok) {
    console.error(`MinIO is not reachable at ${oracle.endpoint} (see oracle/README.md)`)
    process.exit(2)
  }
}

let failed = 0
for (const scenario of scenarios) {
  if (scenario.skip) {
    console.log(`SKIP ${scenario.name}: ${scenario.skip}`)
    continue
  }
  try {
    let expected: Transcript | undefined
    if (golden) expected = readGolden(scenario.name)
    else expected = await play(scenario, { target: oracle, run: runId() })
    if (!expected) throw new Error("no golden transcript; run with --record")
    if (record) {
      writeGolden(scenario.name, expected)
      console.log(`REC  ${scenario.name} (${expected.length} steps)`)
      continue
    }
    const emulator = await startEmulator()
    let actual: Transcript
    try {
      actual = await play(scenario, { target: emulator.target, run: runId() })
    } finally {
      await emulator.close()
    }
    const difference = diff(expected, actual)
    if (show) console.log(JSON.stringify({ expected, actual }, null, 2))
    if (!difference) {
      console.log(`PASS ${scenario.name} (${expected.length} steps)`)
      continue
    }
    failed++
    console.log(`FAIL ${scenario.name} at step ${difference.index}`)
    console.log(`  minio:    ${JSON.stringify(difference.expected)}`)
    console.log(`  emulator: ${JSON.stringify(difference.actual)}`)
  } catch (error) {
    failed++
    console.log(
      `ERR  ${scenario.name}: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
    )
  }
}
console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios agree`)
process.exit(failed ? 1 : 0)
