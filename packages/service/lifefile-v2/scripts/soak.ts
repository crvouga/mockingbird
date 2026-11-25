import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { runSoak } from "../test/soak.js"

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const minutes = Number(argument("--minutes") ?? 30)
const testsPerMinute = Number(argument("--tests-per-minute") ?? 20)
const windowMinutes = Number(argument("--window-minutes") ?? 5)
const idleMinutes = Number(argument("--idle-minutes") ?? 5)
const out = resolve(argument("--out") ?? `.soak/lifefile-v2-${minutes}m.json`)
if (![minutes, testsPerMinute, windowMinutes, idleMinutes].every((n) => Number.isFinite(n) && n > 0)) {
  console.error("usage: bun scripts/soak.ts --minutes <n> [--tests-per-minute 20] [--window-minutes 5] [--idle-minutes 5] [--out <file>]")
  process.exit(2)
}

const report = await runSoak({
  durationMs: minutes * 60_000,
  testsPerMinute,
  windows: Math.max(2, Math.round(minutes / windowMinutes)),
  idleLeftoverEvery: 10,
  namespaceIdleMs: idleMinutes * 60_000,
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(line),
})
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report.verdict))
console.log(`report: ${out}`)
process.exit(report.verdict.pass ? 0 : 1)
