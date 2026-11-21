import { expect, test } from "bun:test"
import { discoverPackages } from "./lib.ts"

for (const name of [
  "@crvouga/mockingbird-adapter-browser",
  "@crvouga/mockingbird-preview",
  "@crvouga/mockingbird-ui",
]) {
  test(`${name} participates in versioned public releases`, () => {
    const pkg = discoverPackages().find((entry) => entry.name === name)
    expect(pkg?.isPublic).toBe(true)
  })
}
