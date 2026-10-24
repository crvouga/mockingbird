import { describe, expect, test } from "bun:test"
import {
  githubRetryDelayMs,
  initialPackageBlocker,
  isRetryableGitHubError,
  releaseInOrder,
  seedSummary,
  waitForNpmVersion,
} from "./lib.ts"

const release = (name: string, ...runtimeDeps: string[]) => ({ pkg: { name, runtimeDeps } })

describe("npm publish visibility", () => {
  test("an accepted publish waits through stale versions and a temporary 404", async () => {
    const responses = [["1.0.0"], [], ["1.0.0", "1.1.0"]]
    const delays: number[] = []
    expect(
      await waitForNpmVersion("pkg", "1.1.0", {
        versions: async () => responses.shift() ?? [],
        sleep: async (ms) => {
          delays.push(ms)
        },
      }),
    ).toBeNull()
    expect(responses).toEqual([])
    expect(delays).toEqual([10_000, 10_000])
  })

  test("an already visible version needs no delay", async () => {
    expect(
      await waitForNpmVersion("pkg", "1.1.0", {
        versions: async () => ["1.1.0"],
        sleep: async () => {
          throw new Error("must not wait")
        },
      }),
    ).toBeNull()
  })

  test("temporary registry errors are retried", async () => {
    let calls = 0
    expect(
      await waitForNpmVersion("pkg", "1.1.0", {
        versions: async () => (++calls === 1 ? { error: "registry unavailable" } : ["1.1.0"]),
        sleep: async () => {},
      }),
    ).toBeNull()
    expect(calls).toBe(2)
  })

  test("a pending or unavailable version fails after bounded retries with an actionable error", async () => {
    for (const response of [["1.0.0"], { error: "registry unavailable" }]) {
      let queries = 0
      const delays: number[] = []
      const error = await waitForNpmVersion("pkg", "1.1.0", {
        versions: async () => {
          queries++
          return response
        },
        sleep: async (ms) => {
          delays.push(ms)
        },
      })
      expect(error).toContain("pkg@1.1.0 is not visible on npm after 5 minutes")
      expect(error).toContain("retry the release")
      if (!Array.isArray(response)) expect(error).toContain(response.error)
      expect(queries).toBe(31)
      expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(300_000)
    }
  })
})

describe("initialPackageBlocker", () => {
  const ci = { inCi: true, local: false, dryRun: false }

  test("a never-published package is blocked in CI and points to interactive seeding", () => {
    const lines = initialPackageBlocker([], ci)
    expect(lines?.join("\n")).toContain("bun run release:seed")
  })

  test("published packages, local logins and dry runs are never blocked", () => {
    expect(initialPackageBlocker(["1.0.0"], ci)).toBeNull()
    expect(initialPackageBlocker([], { ...ci, local: true })).toBeNull()
    expect(initialPackageBlocker([], { ...ci, dryRun: true })).toBeNull()
  })
})

describe("seedSummary", () => {
  test("names never-published packages and the published ones npm rejected", () => {
    const lines = seedSummary({ needsSeed: ["new-pkg"], needsTrust: ["untrusted"], failed: 2 })
    expect(lines).toEqual([
      "::error::1 initial npm package(s) need an interactive local seed: new-pkg",
      "::error::1 published package(s) were rejected by npm Trusted Publishing and need their publisher attached by the local seed: untrusted",
      "Every other package was released. Run bun run release:seed, then retry CI.",
    ])
  })

  test("does not claim the rest released when something else failed", () => {
    const lines = seedSummary({ needsSeed: ["new-pkg"], needsTrust: [], failed: 2 })
    expect(lines.at(-1)).toBe("Run bun run release:seed, then retry CI.")
  })

  test("existing packages rejected by npm use the publisher-only repair", () => {
    const lines = seedSummary({ needsSeed: [], needsTrust: ["untrusted"], failed: 1 })
    expect(lines.at(-1)).toBe(
      "Every other package was released. Run bun run release:seed -- --trust-only --refresh-rejected, then retry CI.",
    )
  })

  test("says nothing when no package needs the seed", () => {
    expect(seedSummary({ needsSeed: [], needsTrust: [], failed: 1 })).toEqual([])
  })
})

describe("releaseInOrder", () => {
  test("one package that cannot publish does not stop the others; only its dependents are skipped", async () => {
    const releases = [
      release("a"),
      release("new-pkg"),
      release("b"),
      release("dependent", "new-pkg"),
      release("c", "a"),
    ]
    const attempted: string[] = []
    const skipped: string[] = []
    const failed = await releaseInOrder(
      releases,
      async (r) => {
        attempted.push(r.pkg.name)
        return r.pkg.name !== "new-pkg"
      },
      (r) => skipped.push(r.pkg.name),
    )
    expect(attempted).toEqual(["a", "new-pkg", "b", "c"])
    expect(skipped).toEqual(["dependent"])
    expect([...failed].sort()).toEqual(["dependent", "new-pkg"])
  })
})

describe("GitHub release retries", () => {
  test("retries the 500 that aborts a seed, and backs off", () => {
    expect(
      isRetryableGitHubError(
        "HTTP 500 (https://api.github.com/repos/crvouga/mockingbird/releases)",
      ),
    ).toBe(true)
    expect(isRetryableGitHubError("You have exceeded a secondary rate limit")).toBe(true)
    expect(isRetryableGitHubError("HTTP 422 Validation Failed")).toBe(false)
    expect(githubRetryDelayMs(0)).toBe(5000)
    expect(githubRetryDelayMs(1)).toBe(10_000)
    expect(githubRetryDelayMs(8)).toBe(60_000)
  })
})
