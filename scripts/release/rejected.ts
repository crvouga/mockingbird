import { stripVTControlCharacters } from "node:util"
import { $ } from "bun"
import { REPO, WORKFLOW_FILE } from "./lib.ts"

/** Select only public packages that the Release publisher explicitly reported as rejected. */
export function rejectedPackages(log: string, publicNames: ReadonlySet<string>): Set<string> {
  const names = new Set<string>()
  const clean = stripVTControlCharacters(log)
  const reports = clean.matchAll(
    /Check its Trusted Publisher \(repo crvouga\/mockingbird, workflow ci\.yml\): https:\/\/www\.npmjs\.com\/package\/(@[^\s/]+\/[^\s/]+)\/access/g,
  )
  for (const match of reports) {
    const name = match[1]
    if (!name || !publicNames.has(name)) {
      throw new Error(`Release rejected a package outside the current public catalog: ${name}`)
    }
    names.add(name)
  }
  return names
}

/** Read the latest main release, never stale failures from before a successful retry. */
export async function rejectedReleasePackages(
  publicNames: ReadonlySet<string>,
  gh: (args: string[]) => Promise<string> = async (args) => (await $`gh ${args}`.quiet()).text(),
): Promise<Set<string>> {
  const runs = JSON.parse(
    await gh([
      "run",
      "list",
      "--repo",
      REPO,
      "--workflow",
      WORKFLOW_FILE,
      "--branch",
      "main",
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion",
    ]),
  ) as Array<{ databaseId: number; status: string; conclusion: string }>
  const run = runs[0]
  if (!run || run.conclusion === "success") return new Set()
  if (run.status !== "completed") throw new Error("Wait for the current Release run to finish")
  if (run.conclusion !== "failure") {
    throw new Error("The latest Release did not report a completed failure to repair")
  }
  const log = await gh(["run", "view", String(run.databaseId), "--repo", REPO, "--log-failed"])
  return rejectedPackages(log, publicNames)
}
