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
