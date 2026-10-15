import { describe, expect, test } from "bun:test"
import { discoverPackages, type Plan, pinManifest, type Release, topoSort } from "./lib.ts"
import {
  deserializePlan,
  pipelineOptions,
  releaseMatrix,
  selectReleases,
  serializePlan,
  splitReleases,
} from "./pipeline.ts"

function planFor(deps: Record<string, string[]>): Plan {
  const packages = Object.entries(deps).map(([name, runtimeDeps]) => ({
    name,
    runtimeDeps,
    isPublic: true,
    dir: `/checkout/${name}`,
    relDir: name,
    manifestPath: `/checkout/${name}/package.json`,
    sourceDirs: [name],
  }))
  return {
    packages,
    versions: new Map(packages.map((p) => [p.name, "1.2.3"])),
    releases: topoSort(packages).map((pkg) => ({
      pkg,
      version: "1.2.3",
      previous: "1.2.2",
      bump: "patch",
      commits: [],
      dependencyUpdates: pkg.runtimeDeps,
    })),
  }
}

const names = (releases: Release[]) => releases.map((r) => r.pkg.name)

describe("parallel release plan", () => {
  test("transitive prerequisites finish before any independent leaf shard starts", () => {
    const plan = planFor({ leaf: ["middle"], independent: [], middle: ["base"], base: [] })
    expect(names(selectReleases(plan, "prerequisites"))).toEqual(["base", "middle"])
    expect(releaseMatrix(plan)).toEqual(["1/2", "2/2"])
    expect(names(selectReleases(plan, "1/2"))).toEqual(["leaf"])
    expect(names(selectReleases(plan, "2/2"))).toEqual(["independent"])
    expect(selectReleases(plan, "maintenance")).toEqual([])
  })

  test("every real public service releases exactly once with no cross-shard dependency", () => {
    const packages = discoverPackages().filter((p) => p.isPublic)
    const plan = planFor(Object.fromEntries(packages.map((p) => [p.name, p.runtimeDeps])))
    const prerequisites = selectReleases(plan, "prerequisites")
    const matrix = releaseMatrix(plan)
    expect(matrix).toHaveLength(8)
    const shards = matrix.map((group) => selectReleases(plan, group))
    const all = [...prerequisites, ...shards.flat()]
    expect(new Set(names(all)).size).toBe(packages.length)
    expect(all).toHaveLength(packages.length)
    const sizes = shards.map((s) => s.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    const ready = new Set<string>()
    for (const release of prerequisites) {
      expect(release.pkg.runtimeDeps.every((dep) => ready.has(dep))).toBe(true)
      ready.add(release.pkg.name)
    }
    for (const shard of shards) {
      for (const release of shard) {
        expect(release.pkg.runtimeDeps.every((dep) => ready.has(dep))).toBe(true)
      }
    }
  })

  test("unreleased dependencies stay pinned without needing a prerequisite job", () => {
    const plan = planFor({ service: ["stable"], stable: [] })
    plan.releases = plan.releases.filter((r) => r.pkg.name === "service")
    expect(splitReleases(plan).prerequisites).toEqual([])
    expect(releaseMatrix(plan)).toEqual(["1/1"])
    expect(names(selectReleases(plan, "1/1"))).toEqual(["service"])
  })

  test("an empty release skips the matrix, and malformed shard flags fail closed", () => {
    const plan = planFor({})
    expect(releaseMatrix(plan)).toEqual([])
    for (const group of ["", "0/8", "9/8", "1/0", "1/9", "1/2oops", "all"]) {
      expect(() => selectReleases(plan, group)).toThrow("invalid release group")
    }
    for (const args of [["--plan"], ["--group", "1/8"], ["--plan", "--group", "1/8"]]) {
      expect(() => pipelineOptions(args)).toThrow("required together")
    }
    expect(pipelineOptions([])).toBeNull()
  })

  test("the snapshot preserves versions and notes while rebinding paths for another runner", () => {
    const plan = planFor({ base: [], service: ["base"] })
    const raw = serializePlan(plan, "commit-a")
    expect(raw).not.toContain("/checkout")
    const packages = plan.packages.map((p) => ({ ...p, dir: `/other/${p.name}` }))
    const loaded = deserializePlan(raw, "commit-a", packages)
    expect(loaded.versions).toEqual(plan.versions)
    expect(loaded.releases.map((r) => r.version)).toEqual(["1.2.3", "1.2.3"])
    expect(loaded.releases[1]?.pkg.dir).toBe("/other/service")
    expect(loaded.releases[1]?.dependencyUpdates).toEqual(["base"])
    // A prerequisite may have pushed its tag by now. Shards still pack the frozen pin.
    const manifest = pinManifest(
      JSON.stringify({ name: "service", dependencies: { base: "workspace:*" } }),
      "1.2.3",
      loaded.versions,
    )
    expect(JSON.parse(manifest).dependencies.base).toBe("1.2.3")
    expect(() => deserializePlan(raw, "commit-b", packages)).toThrow("different commit")
    expect(() => deserializePlan(raw, "commit-a", [])).toThrow("unknown public package")
  })
})
