/**
 * `mockingbird-preview`: the commands a preview workflow runs.
 *
 *   mockingbird-preview stamp --outdir <dir> --version <sha> [--pr <n> --pr-url <url>]
 *     [--state-version <v>]
 *   mockingbird-preview status --worker <name> --kind build|checks --state <state> --version <sha>
 *     [--run-url <url>] [--summary <s>] [--message <m>] [--wrangler <cmd>]
 *   mockingbird-preview wrangler-config --name <worker> --assets <dir> [--main <path>]
 *     [--compatibility-date <date>] [--run-worker-first <pattern>]… [--pr <n> --pr-url <url>]
 *
 * and, for named Previews of one assets-only Worker, deploy-preview, remove-preview, sweep,
 * pr-section and deployment (./cli-previews.ts).
 *
 * Bun / Node only.
 */
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stampPreviewVersion } from "./build.js"
import {
  PREVIEW_COMMANDS,
  PREVIEW_COMMANDS_USAGE,
  type PreviewCliDeps,
  PreviewUsageError,
} from "./cli-previews.js"
import { PREVIEW_ENV } from "./preview-status.js"

const here = dirname(fileURLToPath(import.meta.url))
const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js"

export const DEFAULT_WRANGLER = "bunx wrangler@4.50.0"
export const PREVIEW_COMPATIBILITY_DATE = "2026-11-13"

/** Where the CLI's output goes. Default the process's streams. */
export type PreviewCliIo = {
  stdout(line: string): void
  stderr(line: string): void
}

const USAGE = `Usage:
  mockingbird-preview stamp --outdir <dir> --version <sha> [--pr <n> --pr-url <url>]
    [--state-version <v>]
  mockingbird-preview status --worker <name> --kind build|checks --state <state> --version <sha>
    [--run-url <url>] [--summary <text>] [--message <text>] [--wrangler <cmd>]
  mockingbird-preview wrangler-config --name <worker> --assets <dir> [--main <path>]
    [--compatibility-date <date>] [--run-worker-first <pattern>]... [--pr <n> --pr-url <url>]
${PREVIEW_COMMANDS_USAGE}`

class UsageError extends PreviewUsageError {}

type Args = Map<string, string[]>

const parseArgs = (argv: readonly string[]): Args => {
  const args: Args = new Map()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (!token.startsWith("--")) throw new UsageError(`Unexpected argument ${token}`)
    const eq = token.indexOf("=")
    let key: string
    let value: string | undefined
    if (eq > 0) {
      key = token.slice(2, eq)
      value = token.slice(eq + 1)
    } else {
      key = token.slice(2)
      value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${key} needs a value`)
      }
      i++
    }
    args.set(key, [...(args.get(key) ?? []), value])
  }
  return args
}

const only = (args: Args, allowed: readonly string[]) => {
  for (const key of args.keys()) {
    if (!allowed.includes(key)) throw new UsageError(`Unknown option --${key}`)
  }
}
const optionalArg = (args: Args, key: string): string | undefined => {
  const values = args.get(key)
  if (values !== undefined && values.length > 1) throw new UsageError(`--${key} given twice`)
  return values?.[0]
}
const requiredArg = (args: Args, key: string): string => {
  const value = optionalArg(args, key)
  if (value === undefined || value === "") throw new UsageError(`--${key} is required`)
  return value
}

const prArg = (args: Args): { number: number; url: string } | undefined => {
  const pr = optionalArg(args, "pr")
  const url = optionalArg(args, "pr-url")
  if (pr === undefined && url === undefined) return undefined
  const number = Number(pr)
  if (!(Number.isInteger(number) && number > 0) || !url) {
    throw new UsageError("--pr and --pr-url go together; --pr is a positive integer")
  }
  return { number, url }
}

const STATES = {
  build: ["building", "deployed", "failed"],
  checks: ["running", "passed", "failed"],
} as const

/** The env entry `status` writes: `{ PREVIEW_BUILD | PREVIEW_CHECKS: json }`. */
export const previewStatusSecret = (input: {
  kind: "build" | "checks"
  state: string
  version: string
  runUrl?: string
  summary?: string
  message?: string
  at?: string
}): Record<string, string> => {
  if (!(STATES[input.kind] as readonly string[]).includes(input.state)) {
    throw new UsageError(`--state for ${input.kind} is one of ${STATES[input.kind].join(", ")}`)
  }
  const value = {
    state: input.state,
    version: input.version,
    at: input.at ?? new Date().toISOString(),
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    ...(input.kind === "checks" && input.summary ? { summary: input.summary } : {}),
    ...(input.kind === "build" && input.message ? { message: input.message } : {}),
  }
  return {
    [input.kind === "build" ? PREVIEW_ENV.build : PREVIEW_ENV.checks]: JSON.stringify(value),
  }
}

/** The wrangler config `wrangler-config` prints. */
export const previewWranglerConfig = (input: {
  name: string
  assets: string
  main?: string
  compatibilityDate?: string
  runWorkerFirst?: readonly string[]
  pr?: { number: number; url: string }
}): Record<string, unknown> => ({
  name: input.name,
  main: input.main ?? join(here, `worker-entry${extension}`),
  compatibility_date: input.compatibilityDate ?? PREVIEW_COMPATIBILITY_DATE,
  assets: {
    directory: input.assets,
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: [...new Set(["/__preview/*", ...(input.runWorkerFirst ?? [])])],
  },
  ...(input.pr === undefined ? {} : { vars: { [PREVIEW_ENV.pr]: JSON.stringify(input.pr) } }),
})

/** Runs a command, resolving with its exit code and the tail of its output. */
const run = (command: readonly string[]): Promise<{ code: number; output: string }> =>
  new Promise((done) => {
    const [file, ...rest] = command
    if (file === undefined) {
      done({ code: 1, output: "empty --wrangler command" })
      return
    }
    let output = ""
    const child = spawn(file, rest, { stdio: ["ignore", "pipe", "pipe"] })
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4_000)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", (error) => done({ code: 1, output: error.message }))
    child.on("close", (code) => done({ code: code ?? 1, output }))
  })

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? ""

const status = async (args: Args, io: PreviewCliIo): Promise<number> => {
  let dir: string | undefined
  try {
    only(args, ["worker", "kind", "state", "version", "run-url", "summary", "message", "wrangler"])
    const worker = requiredArg(args, "worker")
    const kind = requiredArg(args, "kind")
    if (kind !== "build" && kind !== "checks") throw new UsageError("--kind is build or checks")
    const runUrl = optionalArg(args, "run-url")
    const summary = optionalArg(args, "summary")
    const message = optionalArg(args, "message")
    const secret = previewStatusSecret({
      kind,
      state: requiredArg(args, "state"),
      version: requiredArg(args, "version"),
      ...(runUrl === undefined ? {} : { runUrl }),
      ...(summary === undefined ? {} : { summary }),
      ...(message === undefined ? {} : { message }),
    })
    const wrangler = (optionalArg(args, "wrangler") ?? DEFAULT_WRANGLER)
      .split(/\s+/)
      .filter(Boolean)
    dir = await mkdtemp(join(tmpdir(), "mockingbird-preview-"))
    const file = join(dir, "secrets.json")
    await writeFile(file, JSON.stringify(secret), { mode: 0o600 })
    const result = await run([...wrangler, "secret", "bulk", file, "--name", worker])
    if (result.code !== 0) {
      io.stdout(
        `::warning::preview status not written (${kind} ${requiredArg(args, "state")}): wrangler exited ${result.code}${lastLine(result.output) ? `: ${lastLine(result.output)}` : ""}`,
      )
      return 0
    }
    io.stdout(`preview status: ${worker} ${kind} ${requiredArg(args, "state")}`)
    return 0
  } catch (error) {
    io.stdout(
      `::warning::preview status not written: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 0
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const stamp = async (args: Args, io: PreviewCliIo): Promise<number> => {
  only(args, ["outdir", "version", "pr", "pr-url", "state-version"])
  const outdir = requiredArg(args, "outdir")
  const version = requiredArg(args, "version")
  const pr = prArg(args)
  const stateVersion = optionalArg(args, "state-version")
  if (stateVersion === "") throw new UsageError("--state-version needs a value")
  await stampPreviewVersion({
    outdir,
    version,
    ...(pr === undefined ? {} : { pr }),
    ...(stateVersion === undefined ? {} : { stateVersion }),
  })
  io.stdout(`version.json: ${version.slice(0, 7)} (${resolve(outdir)})`)
  return 0
}

const wranglerConfig = (args: Args, io: PreviewCliIo): number => {
  only(args, ["name", "assets", "main", "compatibility-date", "run-worker-first", "pr", "pr-url"])
  const main = optionalArg(args, "main")
  const compatibilityDate = optionalArg(args, "compatibility-date")
  const pr = prArg(args)
  const config = previewWranglerConfig({
    name: requiredArg(args, "name"),
    assets: requiredArg(args, "assets"),
    ...(main === undefined ? {} : { main }),
    ...(compatibilityDate === undefined ? {} : { compatibilityDate }),
    runWorkerFirst: args.get("run-worker-first") ?? [],
    ...(pr === undefined ? {} : { pr }),
  })
  io.stdout(JSON.stringify(config, null, 2))
  return 0
}

/** Runs the CLI; resolves with the exit code. */
export async function runPreviewCli(
  argv: readonly string[],
  io: PreviewCliIo = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
  deps: PreviewCliDeps = {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
  },
): Promise<number> {
  const [command, ...rest] = argv
  if (command === "status") {
    let args: Args
    try {
      args = parseArgs(rest)
    } catch (error) {
      io.stdout(
        `::warning::preview status not written: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 0
    }
    return status(args, io)
  }
  try {
    if (command === "stamp") return await stamp(parseArgs(rest), io)
    if (command === "wrangler-config") return wranglerConfig(parseArgs(rest), io)
    const named = command === undefined ? undefined : PREVIEW_COMMANDS[command]
    if (named) return await named(parseArgs(rest), io, deps)
    if (command === "--help" || command === "-h" || command === "help") {
      io.stdout(USAGE)
      return 0
    }
    throw new UsageError(
      command === undefined ? "A command is required" : `Unknown command ${command}`,
    )
  } catch (error) {
    io.stderr(`mockingbird-preview: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof PreviewUsageError) io.stderr(USAGE)
    return 1
  }
}
