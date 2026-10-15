/** One immutable plan shared by the prerequisite job and the parallel leaf-package shards. */
import { readFileSync } from "node:fs"
import { $ } from "bun"
import { discoverPackages, type Plan, type Release, root } from "./lib.ts"

const MAX_SHARDS = 8

type SavedPlan = {
  sha: string
  versions: [string, string][]
  releases: (Omit<Release, "pkg"> & { name: string })[]
}

export function serializePlan(plan: Plan, sha: string): string {
  return JSON.stringify({
    sha,
    versions: [...plan.versions],
    releases: plan.releases.map(({ pkg, ...release }) => ({ ...release, name: pkg.name })),
  } satisfies SavedPlan)
}

export function deserializePlan(raw: string, sha: string, packages = discoverPackages()): Plan {
  const saved = JSON.parse(raw) as SavedPlan
  if (saved.sha !== sha) throw new Error("release plan belongs to a different commit")
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  return {
    packages,
    versions: new Map(saved.versions),
    releases: saved.releases.map(({ name, ...release }) => {
      const pkg = byName.get(name)
      if (!pkg?.isPublic) throw new Error(`release plan names unknown public package ${name}`)
      return { ...release, pkg }
    }),
  }
}

export async function readPlan(path: string): Promise<Plan> {
  const sha = (await $`git rev-parse HEAD`.cwd(root).quiet()).text().trim()
  return deserializePlan(readFileSync(path, "utf8"), sha)
}

/** Anything another release pins must finish first; the remaining leaves are independent. */
export function splitReleases(plan: Plan): { prerequisites: Release[]; leaves: Release[] } {
  const dependencies = new Set(plan.releases.flatMap((r) => r.pkg.runtimeDeps))
  return {
    prerequisites: plan.releases.filter((r) => dependencies.has(r.pkg.name)),
    leaves: plan.releases.filter((r) => !dependencies.has(r.pkg.name)),
  }
}

export function releaseMatrix(plan: Plan): string[] {
  const count = Math.min(MAX_SHARDS, splitReleases(plan).leaves.length)
  return Array.from({ length: count }, (_, i) => `${i + 1}/${count}`)
}

export function selectReleases(plan: Plan, group: string): Release[] {
  if (group === "maintenance") return []
  const { prerequisites, leaves } = splitReleases(plan)
  if (group === "prerequisites") return prerequisites
  const match = /^(\d+)\/(\d+)$/.exec(group)
  const index = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || index < 1 || total < 1 || index > total || total > MAX_SHARDS) {
    throw new Error(`invalid release group ${group}; expected prerequisites, maintenance, or i/n`)
  }
  return leaves.filter((_, i) => i % total === index - 1)
}

/** Flags are paired so a shard can never silently recompute a plan while other jobs push tags. */
export function pipelineOptions(args: string[]): { path: string; group: string } | null {
  const pathAt = args.indexOf("--plan")
  const groupAt = args.indexOf("--group")
  if (pathAt < 0 && groupAt < 0) return null
  const path = pathAt >= 0 ? args[pathAt + 1] : undefined
  const group = groupAt >= 0 ? args[groupAt + 1] : undefined
  if (!path || path.startsWith("--") || !group || group.startsWith("--")) {
    throw new Error(
      "--plan <file> and --group <prerequisites|maintenance|i/n> are required together",
    )
  }
  return { path, group }
}
