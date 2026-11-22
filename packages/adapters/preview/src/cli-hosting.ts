/**
 * The `mockingbird-preview` commands for the asset preflight (`check`) and for previews hosted
 * somewhere other than a Cloudflare Worker (`host-deploy`, `host-status`, `host-exists`,
 * `host-remove` with `--hosting vercel`). Bun / Node only.
 */
import { lstat, readdir, readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import {
  checkPreviewAssets,
  formatPreviewAssetProblems,
  PREVIEW_ASSET_LIMITS,
} from "./assets-check.js"
import {
  assetLimits,
  type PreviewArgs,
  type PreviewCliDeps,
  PreviewUsageError,
} from "./cli-previews.js"
import type { PreviewAssetFile } from "./cloudflare.js"
import { PREVIEW_ENV } from "./preview-status.js"
import { previewContentType, stampPreviewDirectory } from "./site.js"
import { createVercelPreviewHosting, type PreviewHosting } from "./vercel.js"

type Io = { stdout(line: string): void; stderr(line: string): void }

/** The hosts `--hosting` names. */
export const PREVIEW_HOSTINGS = ["cloudflare", "vercel"] as const
export type PreviewHostingName = (typeof PREVIEW_HOSTINGS)[number]

const one = (args: PreviewArgs, key: string) => {
  const values = args.get(key)
  if (values !== undefined && values.length > 1) throw new PreviewUsageError(`--${key} given twice`)
  return values?.[0]
}
const need = (args: PreviewArgs, key: string) => {
  const value = one(args, key)
  if (!value) throw new PreviewUsageError(`--${key} is required`)
  return value
}
const allow = (args: PreviewArgs, keys: readonly string[]) => {
  for (const key of args.keys())
    if (!keys.includes(key)) throw new PreviewUsageError(`Unknown option --${key}`)
}
const hostingArg = (args: PreviewArgs): PreviewHostingName => {
  const value = one(args, "hosting") ?? "cloudflare"
  if (!(PREVIEW_HOSTINGS as readonly string[]).includes(value))
    throw new PreviewUsageError(`--hosting is one of ${PREVIEW_HOSTINGS.join(", ")}`)
  return value as PreviewHostingName
}

/**
 * `check --outdir <dir> [--hosting cloudflare|vercel] [--max-file-mib n] [--max-files n] [--split]`:
 * fails, naming every offending path, when the build breaks the host's asset limits. With
 * `--split`, files over the per-file limit are split into parts first.
 */
const check = async (args: PreviewArgs, io: Io) => {
  allow(args, ["outdir", "hosting", "max-file-mib", "max-files", "split"])
  const outdir = need(args, "outdir")
  const limits = { ...PREVIEW_ASSET_LIMITS[hostingArg(args)], ...(assetLimits(args) ?? {}) }
  const split = one(args, "split")
  if (split !== undefined && split !== "true" && split !== "false")
    throw new PreviewUsageError("--split takes no value (or true / false)")
  const report = await checkPreviewAssets(outdir, { limits, split: split === "true" })
  for (const path of report.split) io.stdout(`split ${path} into parts (${path}.parts.json)`)
  if (report.problems.length > 0) {
    for (const line of formatPreviewAssetProblems(report.problems, limits).split("\n"))
      io.stdout(`::error::${line}`)
    return 1
  }
  io.stdout(
    `${outdir}: ${report.files} files, ${(report.bytes / 1024 / 1024).toFixed(1)} MiB, within the limits`,
  )
  return 0
}

/** Every regular file under `dir`, as preview files (no special handling of any name). */
export async function readPreviewFiles(dir: string): Promise<PreviewAssetFile[]> {
  const root = resolve(dir)
  const files: PreviewAssetFile[] = []
  const walk = async (folder: string) => {
    const entries = await readdir(folder, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(folder, entry.name)
      const stat = await lstat(path)
      if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) {
        const name = `/${relative(root, path).split(sep).join("/")}`
        files.push({
          path: name,
          bytes: new Uint8Array(await readFile(path)),
          contentType: previewContentType(name),
        })
      } else throw new Error(`${path} is not a regular file`)
    }
  }
  await walk(root)
  if (files.length === 0) throw new Error(`${root} holds no files to deploy`)
  return files
}

const hosting = (args: PreviewArgs, deps: PreviewCliDeps): PreviewHosting => {
  const name = hostingArg(args)
  if (name === "cloudflare")
    throw new PreviewUsageError(
      "--hosting cloudflare is not supported by the host-* commands: the reusable workflow deploys Cloudflare Workers with wrangler (wrangler-config, status). Use --hosting vercel.",
    )
  const env = (key: string) => {
    const value = deps.env[key]
    if (!value) throw new PreviewUsageError(`${key} is required in the environment`)
    return value
  }
  const domain = one(args, "domain")
  return createVercelPreviewHosting({
    token: env("VERCEL_TOKEN"),
    project: env("VERCEL_PROJECT_ID"),
    ...(deps.env.VERCEL_ORG_ID ? { teamId: deps.env.VERCEL_ORG_ID } : {}),
    ...(deps.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? { bypassSecret: deps.env.VERCEL_AUTOMATION_BYPASS_SECRET }
      : {}),
    ...(domain ? { domain } : {}),
    fetch: (input, init) => deps.fetch(String(input), init),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  })
}

const prArgs = (args: PreviewArgs) => {
  const pr = one(args, "pr")
  const url = one(args, "pr-url")
  if (pr === undefined && url === undefined) return undefined
  const number = Number(pr)
  if (!(Number.isInteger(number) && number > 0) || !url)
    throw new PreviewUsageError("--pr and --pr-url go together; --pr is a positive integer")
  return { number, url }
}

/**
 * `host-deploy --hosting vercel --name <preview> --outdir <dir> [--domain <d>] [--version <sha>]
 * [--pr <n> --pr-url <url>] [--max-file-mib n] [--max-files n]`: preflight, stamp, deploy; prints
 * `url=<url>`.
 */
const hostDeploy = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, [
    "hosting",
    "name",
    "outdir",
    "domain",
    "version",
    "pr",
    "pr-url",
    "max-file-mib",
    "max-files",
  ])
  const host = hosting(args, deps)
  const outdir = need(args, "outdir")
  const name = need(args, "name")
  const pr = prArgs(args)
  const version = one(args, "version")
  if (version) await stampPreviewDirectory(outdir, version, pr)
  const limits = { ...PREVIEW_ASSET_LIMITS[hostingArg(args)], ...(assetLimits(args) ?? {}) }
  const report = await checkPreviewAssets(outdir, { limits })
  if (report.problems.length > 0) {
    for (const line of formatPreviewAssetProblems(report.problems, limits).split("\n"))
      io.stdout(`::error::${line}`)
    return 1
  }
  const { url } = await host.deploy({
    name,
    files: await readPreviewFiles(outdir),
    vars: pr === undefined ? {} : { [PREVIEW_ENV.pr]: JSON.stringify(pr) },
  })
  io.stdout(`url=${url}`)
  return 0
}

/** `host-status --hosting vercel --name <preview> --values <json>`: best effort, like `status`. */
const hostStatus = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  try {
    allow(args, ["hosting", "name", "domain", "values"])
    const values: unknown = JSON.parse(need(args, "values"))
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new PreviewUsageError("--values is a JSON object")
    await hosting(args, deps).setStatus(need(args, "name"), values as Record<string, string>)
    io.stdout(`preview status: ${need(args, "name")} ${Object.keys(values).join(", ")}`)
  } catch (error) {
    io.stdout(
      `::warning::preview status not written: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return 0
}

/** `host-exists --hosting vercel --name <preview>`: prints `exists=true|false`. */
const hostExists = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["hosting", "name", "domain"])
  io.stdout(`exists=${await hosting(args, deps).exists(need(args, "name"))}`)
  return 0
}

/** `host-remove --hosting vercel --name <preview>`: a preview already gone is fine. */
const hostRemove = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["hosting", "name", "domain"])
  await hosting(args, deps).remove(need(args, "name"))
  io.stdout(`removed ${need(args, "name")}`)
  return 0
}

export const HOSTING_COMMANDS: Record<
  string,
  (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => Promise<number>
> = {
  check: (args, io) => check(args, io),
  "host-deploy": hostDeploy,
  "host-status": hostStatus,
  "host-exists": hostExists,
  "host-remove": hostRemove,
}

export const HOSTING_COMMANDS_USAGE = `  mockingbird-preview check --outdir <dir> [--hosting cloudflare|vercel] [--max-file-mib <n>]
    [--max-files <n>] [--split]
  mockingbird-preview host-deploy --hosting vercel --name <preview> --outdir <dir> [--domain <d>]
    [--version <sha>] [--pr <n> --pr-url <url>] [--max-file-mib <n>] [--max-files <n>]
  mockingbird-preview host-status --hosting vercel --name <preview> --values <json> [--domain <d>]
  mockingbird-preview host-exists --hosting vercel --name <preview> [--domain <d>]
  mockingbird-preview host-remove --hosting vercel --name <preview> [--domain <d>]`
