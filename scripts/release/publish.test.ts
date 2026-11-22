import { describe, expect, test } from "bun:test"
import {
  bumpVersion,
  burntVersions,
  consumerPeerDependencies,
  firstReleaseVersion,
  githubRetryDelayMs,
  initialPackageBlocker,
  isRetryableGitHubError,
  publishFailureKind,
  releaseInOrder,
  seedSummary,
  skipBurnt,
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
      expect(error).toContain("pkg@1.1.0 is not visible on npm after 15 minutes")
      expect(error).toContain("retry the release")
      if (!Array.isArray(response)) expect(error).toContain(response.error)
      expect(queries).toBe(91)
      expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(900_000)
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
        "HTTP 500 (https://api.github.com/repos/crvouga-organization/mockingbird/releases)",
      ),
    ).toBe(true)
    expect(isRetryableGitHubError("You have exceeded a secondary rate limit")).toBe(true)
    expect(isRetryableGitHubError("HTTP 422 Validation Failed")).toBe(false)
    expect(githubRetryDelayMs(0)).toBe(5000)
    expect(githubRetryDelayMs(1)).toBe(10_000)
    expect(githubRetryDelayMs(8)).toBe(60_000)
  })
})

test("initial releases ignore code-free npm reservations", () => {
  expect(firstReleaseVersion([])).toBe("0.1.0")
  expect(firstReleaseVersion(["0.0.0-reserved"])).toBe("0.1.0")
  expect(firstReleaseVersion(["0.0.0-reserved", "0.2.0"])).toBe("0.2.1")
  expect(bumpVersion("1.2.3-beta.1", "patch")).toBe("1.2.4")
  expect(() => bumpVersion("invalid", "patch")).toThrow("Invalid release version")
})

describe("versions npm removed", () => {
  test("a version in the publish history but no longer listed is burnt", () => {
    const time = {
      created: "2026-10-11T00:11:00.112Z",
      modified: "2026-11-15T00:18:58.337Z",
      "0.13.0": "2026-11-14T01:58:18.541Z",
      "0.14.0": "2026-11-14T22:59:25.135Z",
    }
    expect(burntVersions(time, ["0.13.0"])).toEqual(["0.14.0"])
    expect(burntVersions(time, ["0.13.0", "0.14.0"])).toEqual([])
  })

  test("the plan moves past burnt versions to the next patch", () => {
    expect(skipBurnt("0.14.0", new Set(["0.14.0"]))).toBe("0.14.1")
    expect(skipBurnt("0.14.0", new Set(["0.14.0", "0.14.1"]))).toBe("0.14.2")
    expect(skipBurnt("0.14.0", new Set(["0.13.0"]))).toBe("0.14.0")
  })
})

describe("publishFailureKind", () => {
  test("a taken version is not blamed on the Trusted Publisher", () => {
    expect(
      publishFailureKind(
        'npm error code E400\nnpm error 400 Bad Request - PUT https://registry.npmjs.org/@x%2fy - Cannot publish over previously published version "0.14.0".',
      ),
    ).toBe("version-taken")
  })

  test("auth failures point at the Trusted Publisher", () => {
    expect(
      publishFailureKind(
        "npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in",
      ),
    ).toBe("auth")
    expect(publishFailureKind("npm error code E403\nnpm error 403 Forbidden - PUT")).toBe("auth")
  })

  test("anything else is reported as a plain publish failure", () => {
    expect(publishFailureKind("npm error code ECONNRESET")).toBe("other")
  })
})

describe("consumerPeerDependencies", () => {
  test("installs every declared peer, optional ones included, skipping provided names", () => {
    const peers = consumerPeerDependencies(
      [
        {
          name: "@crvouga/mockingbird-ui",
          peerDependencies: { "@heroui/react": "^3.2.7", react: ">=19.0.0" },
        },
        { name: "@crvouga/a", peerDependencies: { esbuild: ">=0.28.0", "@crvouga/b": "1.0.0" } },
        { name: "@crvouga/b", peerDependencies: { esbuild: ">=0.28.0", typescript: "*" } },
      ],
      new Set(["@crvouga/b", "typescript"]),
    )
    expect(peers).toEqual({ "@heroui/react": "^3.2.7", esbuild: ">=0.28.0", react: ">=19.0.0" })
  })

  test("intersects different ranges declared for one peer", () => {
    const peers = consumerPeerDependencies(
      [
        { name: "a", peerDependencies: { react: ">=18.0.0" } },
        { name: "b", peerDependencies: { react: "^19.1.0" } },
      ],
      new Set(),
    )
    expect(peers).toEqual({ react: ">=18.0.0 ^19.1.0" })
  })
})
