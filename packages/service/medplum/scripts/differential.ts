/**
 * Live differential: run every scenario against a booted oracle and a fresh mock, and report
 * each divergence. `bun scripts/differential.ts [--filter <text>] [--oracle-url <url>]`.
 */
import { startOracle } from "../oracle/index.js"
import { diff } from "../test/harness/canonical.js"
import { runScenario } from "../test/harness/scenario.js"
import { mockTarget, type Target } from "../test/harness/target.js"
import { scenarios } from "../test/scenarios/index.js"

const args = process.argv.slice(2)
const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : undefined
const oracleUrl = args.includes("--oracle-url") ? args[args.indexOf("--oracle-url") + 1] : undefined

let stop = async () => {}
let oracle: Target
if (oracleUrl) {
  oracle = {
    name: "oracle",
    baseUrl: oracleUrl,
    fetch: (request) => {
      const url = new URL(request.url)
      const target = new URL(oracleUrl)
      target.pathname = url.pathname
      target.search = url.search
      return fetch(new Request(target, request))
    },
  }
} else {
  const booted = await startOracle({
    onLog: (line) => (/error/i.test(line) ? console.error(line.slice(0, 300)) : undefined),
  })
  oracle = { name: "oracle", baseUrl: booted.baseUrl, fetch: (request) => booted.fetch(request) }
  stop = () => booted.stop()
}
const mock = mockTarget({ baseUrl: "http://mock.medplum.local/" })

let failures = 0
let steps = 0
for (const scenario of scenarios.filter((s) => !filter || s.name.includes(filter))) {
  const t0 = performance.now()
  const real = await runScenario(oracle, scenario)
  const t1 = performance.now()
  const fake = await runScenario(mock, scenario)
  const t2 = performance.now()
  if (args.includes("--timing")) {
    console.log(
      `  ${scenario.name}: oracle ${(t1 - t0).toFixed(0)}ms, mock ${(t2 - t1).toFixed(0)}ms`,
    )
  }
  real.exchanges.forEach((entry, index) => {
    steps++
    const other = fake.exchanges[index]
    const differences = diff(entry.exchange, other?.exchange)
    if (differences.length > 0) {
      failures++
      console.log(`✗ ${scenario.name} › ${entry.step}`)
      for (const line of differences.slice(0, 12)) console.log(`    ${line}`)
    }
  })
}
console.log(`\n${steps - failures}/${steps} steps agree`)
await stop()
process.exit(failures > 0 ? 1 : 0)
