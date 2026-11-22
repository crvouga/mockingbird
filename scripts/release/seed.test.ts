import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPackages, root } from "./lib.ts"

async function dryRun(script: string, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "mockingbird-trust-test-"))
  const calls = join(dir, "calls")
  writeFileSync(calls, "")
  try {
    for (const name of ["npm", "bun", "git", "gh"]) {
      writeFileSync(
        join(dir, name),
        `#!/bin/sh
printf '%s\\n' '${name}'" $*" >> "$TEST_RELEASE_CALLS"
case '${name}'" $1" in
  'npm --version') echo '11.15.0';;
  'npm view') echo '["1.0.0"]';;
  'gh run')
    case "$2" in
      list) echo '[{"databaseId":42,"status":"completed","conclusion":"failure"}]';;
      view) echo 'Check its Trusted Publisher (repo crvouga/mockingbird, workflow ci.yml): https://www.npmjs.com/package/@crvouga/mockingbird-service-ecs/access';;
      *) exit 99;;
    esac;;
  'bun scripts/release/publish.ts') exit 0;;
  *) exit 99;;
esac
`,
        { mode: 0o755 },
      )
    }
    const proc = Bun.spawn([process.execPath, script, ...args], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEST_RELEASE_CALLS: calls,
        GITHUB_ACTIONS: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr, calls: readFileSync(calls, "utf8").trim().split("\n") }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("publisher-only seed skips checkout, install, build, and login in a dry run", async () => {
  const result = await dryRun("scripts/release/seed.ts", ["--trust-only", "--dry-run"])
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.calls).toEqual([
    "npm --version",
    "bun scripts/release/publish.ts --local --trust-only --dry-run",
  ])
})

test("publisher-only seed forwards the explicit rejected-publisher refresh", async () => {
  const result = await dryRun("scripts/release/seed.ts", [
    "--trust-only",
    "--refresh-rejected",
    "--dry-run",
  ])
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.calls.at(-1)).toBe(
    "bun scripts/release/publish.ts --local --trust-only --refresh-rejected --dry-run",
  )
})

test("refresh cannot be used by a seed that publishes packages", async () => {
  const result = await dryRun("scripts/release/seed.ts", ["--refresh-rejected", "--dry-run"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("--refresh-rejected requires --trust-only")
  expect(result.calls).toEqual([""])
})

test("refresh inspects only packages rejected by the latest Release", async () => {
  const result = await dryRun("scripts/release/publish.ts", [
    "--local",
    "--trust-only",
    "--refresh-rejected",
    "--dry-run",
  ])
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.calls.filter((call) => call.startsWith("gh "))).toHaveLength(2)
  expect(result.calls.filter((call) => call.startsWith("npm "))).toEqual([
    "npm view @crvouga/mockingbird-service-ecs versions --json --prefer-online",
  ])
  expect(result.stdout).toContain("refreshing 1 publisher(s)")
  expect(result.stdout).toContain(
    "would verify and repair Trusted Publisher for @crvouga/mockingbird-service-ecs",
  )
})

test("publisher-only publish checks existing services without release or git operations", async () => {
  const packages = discoverPackages().filter((pkg) => pkg.isPublic)
  const originals = packages.map((pkg) => readFileSync(pkg.manifestPath, "utf8"))
  const result = await dryRun("scripts/release/publish.ts", [
    "--local",
    "--trust-only",
    "--dry-run",
  ])
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.calls).toHaveLength(packages.length)
  expect(result.calls.every((call) => call.startsWith("npm view "))).toBe(true)
  for (const pkg of packages) {
    expect(result.stdout).toContain(`would verify and repair Trusted Publisher for ${pkg.name}`)
  }
  expect(packages.map((pkg) => readFileSync(pkg.manifestPath, "utf8"))).toEqual(originals)
}, 15_000)
