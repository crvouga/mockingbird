import { expect, test } from "bun:test"
import coverage from "../coverage.json" with { type: "json" }
import manifest from "../package.json" with { type: "json" }
import { nativeProviders } from "./targets.js"

// The tests import these services by relative path (`../../../service/${name}/src/…`), which
// scripts/check-boundaries.ts cannot resolve. Only a declared dependency makes turbo and the CI
// plan rerun this package when one of them changes.
test("every native provider the tests load is a declared devDependency", () => {
  const declared = new Set(Object.keys(manifest.devDependencies))
  const missing = nativeProviders
    .map((name) => `@crvouga/mockingbird-service-${name}`)
    .filter((name) => !declared.has(name))
  expect(missing).toEqual([])
})

test("the native provider list matches the pinned coverage", () => {
  expect<string[]>([...nativeProviders].sort()).toEqual(Object.keys(coverage.services).sort())
})
