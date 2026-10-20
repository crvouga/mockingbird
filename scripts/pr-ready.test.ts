import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "pr-ready.ts")
const branch = "resolve-batch"

async function fixture(previousState: "MERGED" | "CLOSED" | "OPEN") {
  const directory = await mkdtemp(join(tmpdir(), "pr-ready-test-"))
  const repo = join(directory, "repo")
  const bin = join(directory, "bin")
  const statePath = join(directory, "state.json")
  const callsPath = join(directory, "calls.jsonl")
  await mkdir(repo)
  await mkdir(bin)

  async function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  await git("init", "--quiet", "--initial-branch", branch)
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "test: batch",
  )
  // A local origin is sufficient for the CLI's published-branch check; no network is used.
  await git("remote", "add", "origin", repo)

  const predecessor = {
    number: 1,
    url: "https://example.invalid/pull/1",
    state: previousState,
    title: "Previous batch",
    isDraft: previousState === "OPEN",
    baseRefName: "main",
    headRefName: branch,
    headRefOid: "test-sha",
  }
  await writeFile(statePath, JSON.stringify([predecessor]))
  const fakeGh = join(bin, "gh")
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const statePath = process.env.PR_TEST_STATE
appendFileSync(process.env.PR_TEST_CALLS, JSON.stringify(args) + "\\n")
const prs = JSON.parse(readFileSync(statePath, "utf8"))
const value = (flag) => args[args.indexOf(flag) + 1]
const output = (result) => console.log(JSON.stringify(result))
if (args[0] === "auth" && args[1] === "status") process.exit(0)
if (args[0] !== "pr") throw new Error("unexpected gh command")
switch (args[1]) {
  case "view": output(prs[0]); break
  case "list":
    output(prs.filter(pr =>
      pr.state.toLowerCase() === value("--state") &&
      pr.headRefName === value("--head") && pr.baseRefName === value("--base")
    ).slice(0, Number(value("--limit"))))
    break
  case "create": {
    if (prs.some(pr => pr.state === "OPEN")) throw new Error("duplicate open PR")
    const created = { ...prs[0], number: 2, url: "https://example.invalid/pull/2",
      state: "OPEN", isDraft: false, title: value("--title") }
    prs.push(created)
    writeFileSync(statePath, JSON.stringify(prs))
    console.log(created.url)
    break
  }
  case "ready":
    prs.find(pr => pr.state === "OPEN").isDraft = false
    writeFileSync(statePath, JSON.stringify(prs))
    break
  default: throw new Error("unexpected gh command")
}
`,
  )
  await chmod(fakeGh, 0o755)

  return {
    async pr(...args: string[]) {
      const process = Bun.spawn([Bun.which("bun") ?? "bun", cli, "pr", ...args], {
        cwd: repo,
        env: {
          ...Bun.env,
          PATH: `${bin}:${Bun.env.PATH}`,
          PR_TEST_STATE: statePath,
          PR_TEST_CALLS: callsPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      return JSON.parse(stdout) as { created: boolean; number: number; isDraft?: boolean }
    },
    async calls() {
      return (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

for (const previousState of ["MERGED", "CLOSED"] as const) {
  test(`creates one new batch PR after a ${previousState.toLowerCase()} predecessor`, async () => {
    const sandbox = await fixture(previousState)
    try {
      const args = ["--title", "fix: next batch", "--body", "Batch evidence"]
      expect(await sandbox.pr(...args)).toMatchObject({ created: true, number: 2 })
      expect(await sandbox.pr(...args)).toMatchObject({ created: false, number: 2 })
      const calls = await sandbox.calls()
      expect(calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1)
    } finally {
      await sandbox.cleanup()
    }
  })
}

test("reuses the existing open batch draft and can mark it ready", async () => {
  const sandbox = await fixture("OPEN")
  try {
    expect(await sandbox.pr()).toMatchObject({ created: false, number: 1, isDraft: true })
    expect(await sandbox.pr("--ready")).toMatchObject({ created: false, number: 1, isDraft: false })
    const calls = await sandbox.calls()
    expect(calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(0)
    expect(calls.filter((args) => args[0] === "pr" && args[1] === "ready")).toHaveLength(1)
  } finally {
    await sandbox.cleanup()
  }
})
