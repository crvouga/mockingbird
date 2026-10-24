import { expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPackages, type Plan, root, topoSort } from "./lib.ts"
import { serializePlan } from "./pipeline.ts"

test("CI build and publish consume the frozen group without replanning or reconciling every package", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mockingbird-release-pipeline-"))
  const checkout = join(dir, "checkout")
  const calls = join(dir, "calls")
  const version = "7.8.9"
  const packages = discoverPackages()
  const selected = packages.filter((p) => /-service-(sqlite|stripe|postgres)$/.test(p.name))
  const plan: Plan = {
    packages,
    versions: new Map(selected.map((p) => [p.name, version])),
    releases: topoSort(selected).map((pkg) => ({
      pkg,
      previous: "7.8.8",
      version,
      bump: "patch",
      commits: [],
      dependencyUpdates: pkg.runtimeDeps,
    })),
  }
  const path = join(dir, "plan.json")
  writeFileSync(path, serializePlan(plan, "frozen-sha"))
  writeFileSync(calls, "")
  // Exercise real CLI timeout paths without spending five minutes per failure.
  const clock = join(dir, "clock.ts")
  writeFileSync(
    clock,
    `import { appendFileSync } from "node:fs"
Bun.sleep = async (ms) => { appendFileSync(process.env.TEST_RELEASE_CALLS, "sleep " + ms + "\\n") }
`,
  )
  const originals = selected.map((p) => readFileSync(p.manifestPath, "utf8"))
  try {
    cpSync(join(root, "scripts"), join(checkout, "scripts"), { recursive: true })
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({ type: "module", workspaces: ["packages/service/*"] }),
    )
    for (const pkg of selected) {
      const destination = join(checkout, pkg.relDir)
      mkdirSync(destination, { recursive: true })
      cpSync(pkg.manifestPath, join(destination, "package.json"))
    }
    mkdirSync(join(dir, "package"))
    writeFileSync(
      join(dir, "package/package.json"),
      JSON.stringify({
        name: "@crvouga/mockingbird-service-stripe",
        version,
        dependencies: { "@crvouga/mockingbird-service-sqlite": version },
      }),
    )
    const tarball = join(dir, "stripe.tgz")
    expect(Bun.spawnSync(["tar", "-czf", tarball, "-C", dir, "package"]).exitCode).toBe(0)
    const missing = join(dir, "missing")
    for (const name of ["npm", "git", "gh", "bunx", "bun"]) {
      writeFileSync(
        join(dir, name),
        `#!/bin/sh
printf '%s\\n' '${name}'" $*" >> "$TEST_RELEASE_CALLS"
case '${name}'" $*" in
  'git rev-parse HEAD') echo frozen-sha;;
  'git tag --list '*) exit 0;;
  'npm view '*)
    if [ -f "$TEST_RELEASE_MISSING.stuck" ]; then echo '["7.8.8"]';
    elif [ -f "$TEST_RELEASE_MISSING.dependency" ] && [ "$2" = '@crvouga/mockingbird-service-sqlite' ]; then
      if [ -f "$TEST_RELEASE_MISSING.dependency-visible" ]; then echo '["${version}"]';
      else touch "$TEST_RELEASE_MISSING.dependency-visible"; echo '["7.8.8"]'; fi
    elif [ -f "$TEST_RELEASE_MISSING.processing" ]; then
      if [ -f "$TEST_RELEASE_MISSING.visible" ]; then echo '["${version}"]';
      else touch "$TEST_RELEASE_MISSING.visible"; echo '["7.8.8"]'; fi
    elif [ -f "$TEST_RELEASE_MISSING" ]; then echo '["7.8.8"]'; else echo '["${version}"]'; fi;;
  'npm publish '*) touch "$TEST_RELEASE_MISSING.processing";;
  'git rev-parse -q --verify '*) exit 1;;
  'git tag -a '*|'git push '*|'gh release view '*) exit 0;;
  'bun pm pack '*) echo "$TEST_RELEASE_TARBALL";;
  'bunx turbo run build '*) exit 0;;
  *) exit 99;;
esac
`,
        { mode: 0o755 },
      )
    }
    async function run(script: string, group: string, extra: string[] = [], expectedCode = 0) {
      const proc = Bun.spawn(
        [
          process.execPath,
          "--preload",
          clock,
          `scripts/release/${script}.ts`,
          "--plan",
          path,
          "--group",
          group,
          ...extra,
        ],
        {
          cwd: checkout,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            TEST_RELEASE_CALLS: calls,
            TEST_RELEASE_MISSING: missing,
            TEST_RELEASE_TARBALL: tarball,
            GITHUB_ACTIONS: "true",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      if (expectedCode === 0) expect(stderr).toBe("")
      expect(code).toBe(expectedCode)
      return stdout + stderr
    }
    await run("build", "prerequisites")
    await run("build", "1/2")
    const output = await run("publish", "1/2", ["--dry-run"])
    const recorded = readFileSync(calls, "utf8").trim().split("\n")
    expect(recorded.filter((c) => c.startsWith("bunx "))).toEqual([
      "bunx turbo run build --filter=@crvouga/mockingbird-service-sqlite --output-logs=errors-only",
      "bunx turbo run build --filter=@crvouga/mockingbird-service-postgres --output-logs=errors-only",
    ])
    expect(recorded.filter((c) => c.startsWith("npm "))).toEqual([
      "npm view @crvouga/mockingbird-service-postgres versions --json --prefer-online",
    ])
    expect(recorded.some((c) => c.startsWith("gh "))).toBe(false)
    expect(output).toContain(`skip @crvouga/mockingbird-service-postgres@${version}`)
    expect(output).toContain("released=1 failed=0")
    // Another runner failed to publish SQLite. Its dependent must fail before npm publish,
    // even though it cannot see the prerequisite runner's in-memory set of failed packages.
    writeFileSync(missing, "")
    const blocked = await run("publish", "2/2", ["--dry-run"], 1)
    expect(blocked).toContain(
      `pins @crvouga/mockingbird-service-sqlite@${version}, which is not on npm`,
    )
    expect(blocked).toContain("released=0 failed=1")
    expect(readFileSync(calls, "utf8")).not.toContain("npm publish")
    // A different runner may still see stale metadata for a published prerequisite.
    writeFileSync(calls, "")
    writeFileSync(`${missing}.dependency`, "")
    const dependent = await run("publish", "2/2")
    expect(dependent).toContain(`waiting for @crvouga/mockingbird-service-sqlite@${version}`)
    expect(dependent).toContain("released=1 failed=0")
    const dependentCalls = readFileSync(calls, "utf8").trim().split("\n")
    const dependencyAt = dependentCalls.findIndex((c) =>
      c.includes("npm view @crvouga/mockingbird-service-sqlite"),
    )
    expect(dependentCalls.slice(dependencyAt, dependencyAt + 3)).toEqual([
      "npm view @crvouga/mockingbird-service-sqlite versions --json --prefer-online",
      "sleep 10000",
      "npm view @crvouga/mockingbird-service-sqlite versions --json --prefer-online",
    ])
    expect(dependentCalls.findIndex((c) => c.startsWith("npm publish "))).toBeGreaterThan(
      dependencyAt + 2,
    )
    for (const suffix of ["dependency", "dependency-visible", "processing", "visible"]) {
      rmSync(`${missing}.${suffix}`, { force: true })
    }
    // npm accepts the prerequisite but serves stale metadata on the next read.
    // The job must not tag it or finish until a fresh registry read sees the pin.
    writeFileSync(calls, "")
    writeFileSync(
      join(dir, "package/package.json"),
      JSON.stringify({
        name: "@crvouga/mockingbird-service-sqlite",
        version,
      }),
    )
    expect(Bun.spawnSync(["tar", "-czf", tarball, "-C", dir, "package"]).exitCode).toBe(0)
    const published = await run("publish", "prerequisites")
    expect(published).toContain(`waiting for @crvouga/mockingbird-service-sqlite@${version}`)
    expect(published).toContain("released=1 failed=0")
    const publishedCalls = readFileSync(calls, "utf8").trim().split("\n")
    const publishAt = publishedCalls.findIndex((c) => c.startsWith("npm publish "))
    expect(publishAt).toBeGreaterThan(0)
    expect(publishedCalls.slice(publishAt + 1, publishAt + 5)).toEqual([
      "npm view @crvouga/mockingbird-service-sqlite versions --json --prefer-online",
      "sleep 10000",
      "npm view @crvouga/mockingbird-service-sqlite versions --json --prefer-online",
      `git rev-parse -q --verify refs/tags/@crvouga/mockingbird-service-sqlite@${version}`,
    ])
    // An accepted version that never becomes visible must not receive a tag.
    // Retry the same plan once it is visible without publishing that version twice.
    writeFileSync(calls, "")
    writeFileSync(`${missing}.stuck`, "")
    const timedOut = await run("publish", "prerequisites", [], 1)
    expect(timedOut).toContain("not visible on npm after 5 minutes")
    expect(timedOut).toContain("released=0 failed=1")
    const timedOutCalls = readFileSync(calls, "utf8").trim().split("\n")
    expect(timedOutCalls.filter((c) => c === "sleep 10000")).toHaveLength(30)
    expect(timedOutCalls.some((c) => c.startsWith("git tag -a "))).toBe(false)
    expect(timedOutCalls.some((c) => c.startsWith("git push "))).toBe(false)
    rmSync(`${missing}.stuck`)
    const resumed = await run("publish", "prerequisites")
    expect(resumed).toContain(`skip @crvouga/mockingbird-service-sqlite@${version}`)
    expect(resumed).toContain("released=1 failed=0")
    expect(
      readFileSync(calls, "utf8")
        .split("\n")
        .filter((c) => c.startsWith("npm publish ")),
    ).toHaveLength(1)
    expect(
      selected.map((p) => readFileSync(join(checkout, p.relDir, "package.json"), "utf8")),
    ).toEqual(originals)
    expect(selected.map((p) => readFileSync(p.manifestPath, "utf8"))).toEqual(originals)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
