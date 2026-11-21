import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_WRANGLER,
  PREVIEW_COMPATIBILITY_DATE,
  previewStatusSecret,
  runPreviewCli,
} from "./src/cli-main.js"

const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-cli-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A stand-in for wrangler: records its arguments, the secrets file and its mode. */
const fakeWrangler = join(root, "fake-wrangler.ts")
writeFileSync(
  fakeWrangler,
  `import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const file = args[2]
writeFileSync(process.env.FAKE_WRANGLER_OUT, JSON.stringify({
  args,
  content: file && existsSync(file) ? readFileSync(file, "utf8") : null,
  mode: file && existsSync(file) ? statSync(file).mode & 0o777 : null,
}))
if (process.env.FAKE_WRANGLER_FAIL) { console.error("Authentication error [code: 10000]"); process.exit(3) }
`,
)

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  }
}

const record = join(root, "record.json")
const wrangler = `${process.execPath} ${fakeWrangler}`

describe("mockingbird-preview status", () => {
  test("writes PREVIEW_BUILD to a 0600 temp file, runs wrangler secret bulk, then deletes it", async () => {
    process.env.FAKE_WRANGLER_OUT = record
    const { out, io: sink } = io()
    const code = await runPreviewCli(
      [
        "status",
        "--worker",
        "lab-pr-12",
        "--kind",
        "build",
        "--state",
        "failed",
        "--version",
        "abc123",
        "--run-url",
        "https://github.com/o/r/actions/runs/1",
        "--message=The build failed",
        "--wrangler",
        wrangler,
      ],
      sink,
    )
    expect(code).toBe(0)
    expect(out).toEqual(["preview status: lab-pr-12 build failed"])
    const seen = JSON.parse(readFileSync(record, "utf8"))
    expect(seen.args[0]).toBe("secret")
    expect(seen.args[1]).toBe("bulk")
    expect(seen.args.slice(3)).toEqual(["--name", "lab-pr-12"])
    expect(seen.mode).toBe(0o600)
    const secrets = JSON.parse(seen.content)
    expect(Object.keys(secrets)).toEqual(["PREVIEW_BUILD"])
    const value = JSON.parse(secrets.PREVIEW_BUILD)
    expect(value).toMatchObject({
      state: "failed",
      version: "abc123",
      runUrl: "https://github.com/o/r/actions/runs/1",
      message: "The build failed",
    })
    expect(Number.isNaN(Date.parse(value.at))).toBe(false)
    expect(existsSync(seen.args[2])).toBe(false)
  })

  test("checks go to PREVIEW_CHECKS with a summary", async () => {
    process.env.FAKE_WRANGLER_OUT = record
    const { io: sink } = io()
    await runPreviewCli(
      [
        "status",
        "--worker",
        "w",
        "--kind",
        "checks",
        "--state",
        "passed",
        "--version",
        "abc",
        "--summary",
        "4 of 4 passed",
        "--wrangler",
        wrangler,
      ],
      sink,
    )
    const secrets = JSON.parse(JSON.parse(readFileSync(record, "utf8")).content)
    expect(JSON.parse(secrets.PREVIEW_CHECKS)).toMatchObject({
      state: "passed",
      summary: "4 of 4 passed",
    })
  })

  test("a wrangler failure is a warning, exit 0, and the file is still deleted", async () => {
    process.env.FAKE_WRANGLER_OUT = record
    process.env.FAKE_WRANGLER_FAIL = "1"
    try {
      const { out, io: sink } = io()
      const code = await runPreviewCli(
        [
          "status",
          "--worker",
          "w",
          "--kind",
          "build",
          "--state",
          "building",
          "--version",
          "a",
        ].concat(["--wrangler", wrangler]),
        sink,
      )
      expect(code).toBe(0)
      expect(out[0]).toStartWith(
        "::warning::preview status not written (build building): wrangler exited 3",
      )
      expect(out[0]).toContain("Authentication error")
      expect(existsSync(JSON.parse(readFileSync(record, "utf8")).args[2])).toBe(false)
    } finally {
      delete process.env.FAKE_WRANGLER_FAIL
    }
  })

  test("bad arguments and a missing wrangler are warnings with exit 0", async () => {
    for (const argv of [
      ["status"],
      ["status", "--worker"],
      ["status", "--worker", "w", "--kind", "deploy", "--state", "x", "--version", "a"],
      ["status", "--worker", "w", "--kind", "checks", "--state", "deployed", "--version", "a"],
      [
        "status",
        "--worker",
        "w",
        "--kind",
        "build",
        "--state",
        "building",
        "--version",
        "a",
        "--nope",
        "1",
      ],
      [
        "status",
        "--worker",
        "w",
        "--kind",
        "build",
        "--state",
        "building",
        "--version",
        "a",
        "--wrangler",
        join(root, "no-such-binary"),
      ],
    ]) {
      const { out, io: sink } = io()
      expect(await runPreviewCli(argv, sink)).toBe(0)
      expect(out[0]).toStartWith("::warning::preview status not written")
    }
  })

  test("previewStatusSecret and the default wrangler", () => {
    expect(DEFAULT_WRANGLER).toBe("bunx wrangler@4.50.0")
    const secret = previewStatusSecret({ kind: "build", state: "deployed", version: "v", at: "t" })
    expect(secret).toEqual({
      PREVIEW_BUILD: JSON.stringify({ state: "deployed", version: "v", at: "t" }),
    })
  })
})

describe("mockingbird-preview stamp", () => {
  test("stamps version.json from build.json", async () => {
    const outdir = join(root, "dist")
    mkdirSync(outdir, { recursive: true })
    writeFileSync(join(outdir, "build.json"), JSON.stringify({ entry: "./app-1.js" }))
    const { out, io: sink } = io()
    const code = await runPreviewCli(
      [
        "stamp",
        "--outdir",
        outdir,
        "--version",
        "0123456789abc",
        "--pr",
        "5",
        "--pr-url",
        "https://github.com/o/r/pull/5",
      ],
      sink,
    )
    expect(code).toBe(0)
    expect(out[0]).toStartWith("version.json: 0123456")
    const version = JSON.parse(readFileSync(join(outdir, "version.json"), "utf8"))
    expect(version).toMatchObject({
      version: "0123456789abc",
      entry: "./app-1.js",
      pr: { number: 5, url: "https://github.com/o/r/pull/5" },
    })
  })

  test("usage errors exit 1", async () => {
    for (const argv of [
      ["stamp", "--outdir", root],
      ["stamp", "--outdir", root, "--version", "a", "--pr", "5"],
      ["stamp", "--outdir", join(root, "none"), "--version", "a"],
      ["nope"],
      [],
    ]) {
      const { err, io: sink } = io()
      expect(await runPreviewCli(argv, sink)).toBe(1)
      expect(err[0]).toStartWith("mockingbird-preview: ")
    }
  })
})

describe("mockingbird-preview wrangler-config", () => {
  test("prints a wrangler config for the generic preview Worker", async () => {
    const { out, io: sink } = io()
    expect(
      await runPreviewCli(
        ["wrangler-config", "--name", "lab-pr-1", "--assets", "./preview-dist"],
        sink,
      ),
    ).toBe(0)
    const config = JSON.parse(out.join("\n"))
    expect(config).toEqual({
      name: "lab-pr-1",
      main: expect.stringMatching(/[/\\]worker-entry\.(ts|js)$/),
      compatibility_date: PREVIEW_COMPATIBILITY_DATE,
      assets: {
        directory: "./preview-dist",
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: ["/__preview/*"],
      },
    })
    expect(existsSync(config.main)).toBe(true)
  })

  test("main, compatibility date, extra worker-first paths and the PR var", async () => {
    const { out, io: sink } = io()
    await runPreviewCli(
      [
        "wrangler-config",
        "--name",
        "lab",
        "--assets",
        "out",
        "--main",
        "src/worker.ts",
        "--compatibility-date",
        "2026-01-01",
        "--run-worker-first",
        "/__dev",
        "--run-worker-first",
        "/__dev/*",
        "--pr",
        "4",
        "--pr-url",
        "https://github.com/o/r/pull/4",
      ],
      sink,
    )
    const config = JSON.parse(out.join("\n"))
    expect(config.main).toBe("src/worker.ts")
    expect(config.compatibility_date).toBe("2026-01-01")
    expect(config.assets.run_worker_first).toEqual(["/__preview/*", "/__dev", "/__dev/*"])
    expect(config.vars).toEqual({
      PREVIEW_PR: JSON.stringify({ number: 4, url: "https://github.com/o/r/pull/4" }),
    })
  })
})
