import { describe, expect, test } from "bun:test"
import { RESERVED_VERSION, reservationManifest, unreservedPackages } from "./lib.ts"

describe("unreservedPackages", () => {
  test("lists packages npm has never seen and keeps published ones out", async () => {
    const npm: Record<string, string[]> = {
      "@x/a": ["0.1.0"],
      "@x/b": [],
      "@x/c": [RESERVED_VERSION],
    }
    const result = await unreservedPackages(["@x/c", "@x/b", "@x/a"], async (n) => npm[n] ?? [])
    expect(result).toEqual({ missing: ["@x/b"], errors: [] })
  })

  test("retries a registry error once before reporting it", async () => {
    let calls = 0
    const flaky = async () => (++calls === 1 ? { error: "ETIMEDOUT" } : ["1.0.0"])
    expect(await unreservedPackages(["@x/a"], flaky)).toEqual({ missing: [], errors: [] })

    const down = async () => ({ error: "ETIMEDOUT" })
    expect(await unreservedPackages(["@x/a"], down)).toEqual({
      missing: [],
      errors: [{ name: "@x/a", error: "ETIMEDOUT" }],
    })
  })
})

describe("reservationManifest", () => {
  test("ships no code under the placeholder version", () => {
    const manifest = JSON.parse(reservationManifest("@x/a"))
    expect(manifest).toMatchObject({
      name: "@x/a",
      version: RESERVED_VERSION,
      files: ["README.md"],
    })
    expect(manifest.bin).toBeUndefined()
    expect(manifest.main).toBeUndefined()
  })
})
