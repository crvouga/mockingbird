import { expect, test } from "bun:test"
import {
  affectedPackages,
  externalInputs,
  lockfileImpact,
  matchesInputs,
  packageOf,
  readExternalInputs,
  type ScopeRules,
  type WorkspaceGraph,
  withDependents,
} from "./affected.ts"

// core <- a, b (mocks); util <- d (a mock that shares nothing with a or b); docs <- a, d.
const graph: WorkspaceGraph = {
  packages: [
    { name: "core", dir: "packages/core", dependencies: [] },
    { name: "util", dir: "packages/util", dependencies: [] },
    { name: "a", dir: "packages/service/a", dependencies: ["core"] },
    { name: "b", dir: "packages/service/b", dependencies: ["core"] },
    { name: "d", dir: "packages/service/d", dependencies: ["util"] },
    { name: "app", dir: "sites/app", dependencies: ["a", "d", "core", "util"] },
  ],
}

const rules = (over: Partial<ScopeRules> = {}): ScopeRules => ({
  ignored: () => false,
  global: () => false,
  unowned: "none",
  lockfile: "none",
  externalInputs: true,
  ...over,
})
const reach = (files: string[], over?: Partial<ScopeRules>) =>
  [...affectedPackages(graph, files, rules(over))].sort()

test("a change to mock A reaches A and its dependents, never mock B", () => {
  expect(reach(["packages/service/a/src/index.ts"])).toEqual(["a", "app"])
  expect(reach(["packages/service/b/src/index.ts"])).toEqual(["b"])
})

test("a change to a shared package reaches every dependent, and none of the unrelated", () => {
  expect(reach(["packages/core/src/x.ts"])).toEqual(["a", "app", "b", "core"])
  expect(reach(["packages/util/src/x.ts"])).toEqual(["app", "d", "util"])
})

test("changes in two packages reach the union", () => {
  expect(reach(["packages/service/b/x.ts", "packages/util/y.ts"])).toEqual([
    "app",
    "b",
    "d",
    "util",
  ])
})

test("the deepest package directory owns a file", () => {
  const nested: WorkspaceGraph = {
    packages: [
      { name: "outer", dir: "packages/x", dependencies: [] },
      { name: "inner", dir: "packages/x/inner", dependencies: [] },
    ],
  }
  expect(packageOf(nested, "packages/x/inner/a.ts")).toBe("inner")
  expect(packageOf(nested, "packages/x/a.ts")).toBe("outer")
  expect(packageOf(nested, "packages/xy/a.ts")).toBeUndefined()
})

test("ignored files reach nothing, in a package or not", () => {
  const ignored = (f: string) => f.endsWith(".md")
  expect(reach(["packages/core/README.md"], { ignored })).toEqual([])
})

test("a file outside every package reaches all or none, as the caller says", () => {
  expect(reach(["biome.json"], { unowned: "none" })).toEqual([])
  expect(reach(["biome.json"], { unowned: "all" })).toHaveLength(graph.packages.length)
})

test("a global file reaches every package even when it is inside one", () => {
  const global = (f: string) => f === "tsconfig.base.json" || f === "packages/core/shared.json"
  expect(reach(["tsconfig.base.json"], { global })).toHaveLength(graph.packages.length)
  expect(reach(["packages/core/shared.json"], { global })).toHaveLength(graph.packages.length)
})

test("bun.lock reaches what lockfileImpact says", () => {
  expect(reach(["bun.lock"], { lockfile: "none" })).toEqual([])
  expect(reach(["bun.lock"], { lockfile: "all" })).toHaveLength(graph.packages.length)
  expect(reach(["bun.lock"], { lockfile: { workspaces: ["packages/service/d"] } })).toEqual([
    "app",
    "d",
  ])
})

test("withDependents is transitive", () => {
  const chain: WorkspaceGraph = {
    packages: [
      { name: "x", dir: "x", dependencies: [] },
      { name: "y", dir: "y", dependencies: ["x"] },
      { name: "z", dir: "z", dependencies: ["y", "x"] },
    ],
  }
  expect([...withDependents(chain, ["x"])].sort()).toEqual(["x", "y", "z"])
  expect([...withDependents(chain, ["y"])].sort()).toEqual(["y", "z"])
})

const lock = (over: { workspaces?: object; packages?: object; extra?: object } = {}) =>
  JSON.stringify({
    lockfileVersion: 2,
    workspaces: {
      "": { name: "root", devDependencies: { biome: "1" } },
      "packages/a": { name: "a", dependencies: { hono: "1" } },
      ...over.workspaces,
    },
    packages: {
      a: ["a@workspace:packages/a"],
      hono: ["hono@1.0.0", "", {}, "sha512-x"],
      ...over.packages,
    },
    ...over.extra,
  })

test("lockfileImpact: no change, or formatting only, is none", () => {
  expect(lockfileImpact(lock(), lock())).toBe("none")
  expect(lockfileImpact(lock(), `${lock()}\n`)).toBe("none")
})

test("lockfileImpact: a new workspace package touches only that package", () => {
  const head = lock({
    workspaces: { "packages/b": { name: "b", dependencies: { hono: "1" } } },
    packages: { b: ["b@workspace:packages/b"] },
  })
  expect(lockfileImpact(lock(), head)).toEqual({ workspaces: ["packages/b"] })
})

test("lockfileImpact: one package's dependency edit touches only that package", () => {
  const head = lock({ workspaces: { "packages/a": { name: "a", dependencies: { hono: "2" } } } })
  expect(lockfileImpact(lock(), head)).toEqual({ workspaces: ["packages/a"] })
})

test("lockfileImpact: an external package moving, or the root's deps, is all", () => {
  expect(
    lockfileImpact(lock(), lock({ packages: { hono: ["hono@1.0.1", "", {}, "sha512-y"] } })),
  ).toBe("all")
  expect(
    lockfileImpact(lock(), lock({ workspaces: { "": { name: "root", devDependencies: {} } } })),
  ).toBe("all")
  expect(lockfileImpact(lock(), lock({ extra: { overrides: { hono: "2" } } }))).toBe("all")
})

test("a file another package declares as a turbo input reaches that package", () => {
  // `d` shares no dependency with `core`, but its build reads one file inside core and its test
  // another; only the build's result reaches `app`, which depends on d.
  const crossRead: WorkspaceGraph = {
    packages: graph.packages.map((p) =>
      p.name !== "d"
        ? p
        : {
            ...p,
            inputs: [
              { include: ["packages/core/schema.json"], exclude: [], upstream: true },
              { include: ["packages/core/fixture.json"], exclude: [], upstream: false },
            ],
          },
    ),
  }
  const reachX = (files: string[]) => [...affectedPackages(crossRead, files, rules())].sort()
  expect(reachX(["packages/core/schema.json"])).toEqual(["a", "app", "b", "core", "d"])
  expect(reachX(["packages/core/fixture.json"])).toEqual(["a", "app", "b", "core", "d"])
  expect(reachX(["packages/core/other.json"])).toEqual(["a", "app", "b", "core"])
  // Outside every package: a build input reaches dependents, a test input only its reader.
  const loose: WorkspaceGraph = {
    packages: graph.packages.map((p) =>
      p.name !== "d"
        ? p
        : { ...p, inputs: [{ include: ["docs/*.md"], exclude: [], upstream: false }] },
    ),
  }
  expect([...affectedPackages(loose, ["docs/x.md"], rules())]).toEqual(["d"])
  // A scope that opts out (live parity) ignores them.
  expect([...affectedPackages(loose, ["docs/x.md"], rules({ externalInputs: false }))]).toEqual([])
})

test("external inputs follow turbo: per-task override, negations, only tasks with a script", () => {
  const rootTurbo = {
    tasks: {
      build: { dependsOn: ["^build"], inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/shared/**"] },
      lint: { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/biome.json"] },
      "pkg#test": { inputs: ["$TURBO_ROOT$/fixtures/**", "!$TURBO_ROOT$/fixtures/*.tmp"] },
      "//#check": { inputs: ["$TURBO_ROOT$/root-only.ts"] },
    },
  }
  // The package's own turbo.json replaces `build`'s inputs; it has no `lint` script.
  const pkgTurbo = { tasks: { build: { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/other/**"] } } }
  const inputs = externalInputs("pkg", { build: "x", test: "y" }, rootTurbo, pkgTurbo)
  const hits = (file: string) => inputs.some((task) => matchesInputs(task, file))
  expect(hits("other/a.ts")).toBe(true)
  expect(hits("shared/a.ts")).toBe(false)
  expect(hits("biome.json")).toBe(false)
  expect(hits("fixtures/a.json")).toBe(true)
  expect(hits("fixtures/a.tmp")).toBe(false)
  expect(hits("root-only.ts")).toBe(false)
  expect(inputs.map((task) => task.upstream)).toEqual([true, false])
})

test("the node adapter is reached by the docs files its tests compare against", () => {
  // packages/adapters/node/fleet.schema.test.ts reads both; neither lives in the adapter.
  const dir = "packages/adapters/node"
  const inputs = readExternalInputs(dir)
  for (const file of ["sites/docs/public/schemas/fleet-v1.json", "docs/FLEETS.md"]) {
    expect({ file, reached: inputs.some((task) => matchesInputs(task, file)) }).toEqual({
      file,
      reached: true,
    })
  }
})
