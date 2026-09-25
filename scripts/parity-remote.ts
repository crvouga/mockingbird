/**
 * Run live parity on GitHub Actions with the repo's sandbox-key secrets, for the current
 * branch, and stream the log here. Needs only `gh auth login` with write access to the repo:
 * no sandbox keys on this machine.
 *
 *   bun run parity:remote -- stripe twilio     # the named services
 *   bun run parity:remote -- --all             # every service with a parity script
 *
 * The branch must be pushed: the runner checks out what is on GitHub, not this working tree.
 */
import { $ } from "bun"

const WORKFLOW = "parity.yml"

const services = process.argv.slice(2).filter((arg) => arg !== "--")
if (services.length === 0) {
  console.error("usage: bun run parity:remote -- <service…> | --all")
  process.exit(2)
}

const sh = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const result = await $(strings, ...values)
    .quiet()
    .nothrow()
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() }
}

if (!(await sh`gh auth status`).ok) {
  console.error("parity:remote: gh is not authenticated. Run: gh auth login")
  process.exit(1)
}

const branch = (await sh`git rev-parse --abbrev-ref HEAD`).out
if (!branch || branch === "HEAD") {
  console.error("parity:remote: check out a branch first (detached HEAD)")
  process.exit(1)
}
await sh`git fetch --quiet origin ${branch}`
const local = (await sh`git rev-parse HEAD`).out
const remote = (await sh`git rev-parse ${`origin/${branch}`}`).out
if (remote !== local) {
  console.error(
    `parity:remote: origin/${branch} is not at HEAD. Push first (git push -u origin ${branch}); the runner tests what is on GitHub.`,
  )
  process.exit(1)
}

const repo = (await sh`gh repo view --json nameWithOwner --jq .nameWithOwner`).out
const dispatchedAt = Date.now()
const dispatch =
  await sh`gh workflow run ${WORKFLOW} --repo ${repo} --ref ${branch} -f ${`services=${services.join(" ")}`}`
if (!dispatch.ok) {
  console.error(`parity:remote: could not dispatch ${WORKFLOW} (needs write access to ${repo})`)
  process.exit(1)
}
console.log(`Dispatched ${WORKFLOW} on ${repo}@${branch} for: ${services.join(" ")}`)

let runId = ""
for (let attempt = 0; attempt < 30 && !runId; attempt++) {
  await Bun.sleep(2000)
  const listed =
    await sh`gh run list --repo ${repo} --workflow ${WORKFLOW} --branch ${branch} --event workflow_dispatch --limit 5 --json databaseId,createdAt`
  if (!listed.ok) continue
  const runs = JSON.parse(listed.out) as Array<{ databaseId: number; createdAt: string }>
  const fresh = runs.find((run) => Date.parse(run.createdAt) >= dispatchedAt - 5000)
  if (fresh) runId = String(fresh.databaseId)
}
if (!runId) {
  console.error(`parity:remote: the run did not appear; see https://github.com/${repo}/actions`)
  process.exit(1)
}

console.log(`https://github.com/${repo}/actions/runs/${runId}`)
const watch = Bun.spawn(["gh", "run", "watch", runId, "--repo", repo, "--exit-status"], {
  stdio: ["inherit", "inherit", "inherit"],
})
const code = await watch.exited
if (code !== 0) {
  await Bun.spawn(["gh", "run", "view", runId, "--repo", repo, "--log-failed"], {
    stdio: ["inherit", "inherit", "inherit"],
  }).exited
}
process.exit(code)
