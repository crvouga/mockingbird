/**
 * One site's named Preview, end to end: stamp, gate, upload, prove it is served, check it again.
 * Bun / Node only (it reads the built directory). The `mockingbird-preview` CLI wires it to
 * Cloudflare and GitHub; tests inject both.
 */
import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"
import { assertPreviewAssets, type PreviewAssetLimits } from "./assets-check.js"
import type { AssetsOnlyConfig } from "./assets-only.js"
import { stampPreviewVersion } from "./build.js"
import type { CloudflarePreview, createCloudflarePreviews, PreviewAssetFile } from "./cloudflare.js"
import { type PullRequestFacts, planPreviewSweep } from "./lifecycle.js"
import {
  checkUntilPassing,
  type PreviewCheck,
  type PreviewChecks,
  type PreviewHttpFetch,
  type PreviewTarget,
  previewGateUploads,
  runPreviewChecks,
  waitUntilServing,
} from "./serving.js"

type Previews = Pick<ReturnType<typeof createCloudflarePreviews>, "deploy" | "list" | "remove">

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
}
export const previewContentType = (path: string) =>
  TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"

/** Every file under `dir` as a Preview asset; a top-level `_headers` becomes the headers text. */
export async function readPreviewDirectory(
  dir: string,
): Promise<{ files: PreviewAssetFile[]; headers?: string }> {
  const root = resolve(dir)
  const files: PreviewAssetFile[] = []
  let headers: string | undefined
  const walk = async (folder: string) => {
    const entries = await readdir(folder, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const name = `/${relative(root, path).split(sep).join("/")}`
        if (name === "/_headers") headers = await readFile(path, "utf8")
        else if (name === "/_redirects")
          throw new Error("_redirects is not supported by named Previews; remove it")
        else if (name !== "/.assetsignore")
          files.push({
            path: name,
            bytes: new Uint8Array(await readFile(path)),
            contentType: previewContentType(name),
          })
      }
    }
  }
  await walk(root)
  if (files.length === 0) throw new Error(`${root} holds no files to deploy`)
  return { files, ...(headers === undefined ? {} : { headers }) }
}

/** The origin `directoryFetch` answers for. */
export const PREVIEW_LOCAL_ORIGIN = "http://preview.local"

/** A fetch that serves `dir` as static files: what checks read before upload. */
export function directoryFetch(dir: string): PreviewHttpFetch {
  const root = resolve(dir)
  return async (input) => {
    const url = new URL(input, PREVIEW_LOCAL_ORIGIN)
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith("/")) path += "index.html"
    const file = resolve(root, `.${path}`)
    if (file !== root && !file.startsWith(root + sep)) return new Response(null, { status: 404 })
    for (const candidate of [file, `${file}.html`, join(file, "index.html")]) {
      try {
        const bytes = await readFile(candidate)
        return new Response(bytes, { headers: { "content-type": previewContentType(candidate) } })
      } catch {}
    }
    return new Response("Not found", { status: 404 })
  }
}

/** Stamps `version.json` with the commit: through build.json for a buildPreview output, else directly. */
export async function stampPreviewDirectory(
  outdir: string,
  version: string,
  pr?: { number: number; url: string },
) {
  if (existsSync(join(outdir, "build.json")))
    return stampPreviewVersion({ outdir, version, ...(pr ? { pr } : {}) })
  await writeFile(
    join(outdir, "version.json"),
    `${JSON.stringify({ version, builtAt: new Date().toISOString(), ...(pr ? { pr } : {}) }, null, 2)}\n`,
  )
}

export type PreviewSiteState = "live" | "failing-checks" | "failed" | "skipped" | "removed"

export type PreviewSiteResult = {
  site: string
  worker: string
  name: string
  state: PreviewSiteState
  attempted: string
  /** The commit uploaded by this run, when it uploaded. */
  deployed?: string
  url?: string
  gate?: PreviewCheck[]
  after?: PreviewCheck[]
  message?: string
}

export const failedPreviewChecks = (checks: PreviewCheck[]) =>
  checks
    .filter((check) => !check.ok)
    .map((check) => (check.detail ? `${check.name}: ${check.detail}` : check.name))
    .join("; ")

/**
 * Deploys `outdir` as Preview `name` of `worker` and proves it: the gate checks run on the built
 * directory, `deploy()` uploads (unless a branch's gate failed), `version.json` is polled at the
 * custom-domain origin (`https://<name>.<host>`) and, while that domain's certificate is not yet
 * issued, the Preview's own (workers.dev) URL, then the checks run again against what is served.
 */
export async function deployPreviewSite(input: {
  site: string
  worker: string
  name: string
  outdir: string
  commit: string
  target: PreviewTarget
  previews: Previews
  currentPullRequest: () => Promise<PullRequestFacts>
  /** Stamped into version.json with the commit. */
  pr?: { number: number; url: string }
  config?: AssetsOnlyConfig
  host?: string
  checks?: PreviewChecks
  /**
   * The gate's results when they were computed elsewhere (`mockingbird-preview gate-preview` in a
   * job without credentials), in place of running `checks` on the built directory here.
   */
  gate?: PreviewCheck[]
  /**
   * Run `checks` after upload here (default true). The reusable workflow passes false and runs
   * them in a job without credentials (`mockingbird-preview check-preview`).
   */
  checksAfterUpload?: boolean
  /** Refuse the upload when the directory breaks these limits (`assertPreviewAssets`). */
  limits?: Partial<PreviewAssetLimits>
  timeoutMs?: number
  fetch?: PreviewHttpFetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}): Promise<PreviewSiteResult> {
  const log = input.log ?? (() => {})
  const base = { site: input.site, worker: input.worker, name: input.name, attempted: input.commit }
  const poll = {
    timeoutMs: input.timeoutMs ?? 180_000,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.now ? { now: input.now } : {}),
  }
  await stampPreviewDirectory(input.outdir, input.commit, input.pr)
  let gate: PreviewCheck[] | undefined
  if (input.gate || input.checks) {
    const outcome = input.gate
      ? { passed: input.gate.every((check) => check.ok === true), results: input.gate }
      : await runPreviewChecks(
          input.checks as PreviewChecks,
          PREVIEW_LOCAL_ORIGIN,
          directoryFetch(input.outdir),
        )
    gate = outcome.results
    log(`gate: ${outcome.passed ? "passed" : `failed (${failedPreviewChecks(gate)})`}`)
    if (!previewGateUploads(input.target, outcome.passed))
      return {
        ...base,
        state: "failed",
        gate,
        message: `The checks failed before upload, so nothing was uploaded and the last passing deploy keeps serving: ${failedPreviewChecks(gate)}`,
      }
  }
  try {
    await assertPreviewAssets(input.outdir, { ...(input.limits ? { limits: input.limits } : {}) })
  } catch (error) {
    return {
      ...base,
      state: "failed",
      ...(gate ? { gate } : {}),
      message: `Nothing was uploaded: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const { files, headers } = await readPreviewDirectory(input.outdir)
  const deployed = await input.previews.deploy({
    name: input.name,
    commit: input.commit,
    files,
    currentPullRequest: input.currentPullRequest,
    ...(headers === undefined ? {} : { headers }),
    ...(input.config?.compatibilityDate
      ? { compatibilityDate: input.config.compatibilityDate }
      : {}),
    ...(input.config?.htmlHandling ? { htmlHandling: input.config.htmlHandling } : {}),
    ...(input.config?.notFoundHandling ? { notFoundHandling: input.config.notFoundHandling } : {}),
  })
  log(`deploy: ${deployed.action}`)
  if (deployed.action === "skip")
    return { ...base, state: "skipped", message: "The pull request moved on; a newer run deploys" }
  if (deployed.action === "remove")
    return { ...base, state: "removed", message: "The pull request closed; its Preview is removed" }
  const preview = (deployed as { preview?: CloudflarePreview }).preview
  const origins = [
    ...(input.host ? [`https://${input.name}.${input.host}`] : []),
    ...(preview?.urls ?? []),
  ]
  let url: string | undefined
  const errors: string[] = []
  for (const [index, origin] of origins.entries()) {
    try {
      // The custom domain gets a share of the deadline; its certificate may still be issuing.
      const share = index < origins.length - 1 ? Math.min(poll.timeoutMs, 60_000) : poll.timeoutMs
      await waitUntilServing(origin, input.commit, { ...poll, timeoutMs: share })
      url = origin
      break
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (!url)
    return {
      ...base,
      state: "failed",
      ...(gate ? { gate } : {}),
      message:
        origins.length === 0
          ? "Cloudflare returned no URL for the Preview"
          : `Deployed, but never seen served: ${errors.join("; ")}`,
    }
  log(`serving ${input.commit.slice(0, 7)} at ${url}`)
  let after: PreviewCheck[] | undefined
  if (input.checks && input.checksAfterUpload !== false) {
    const outcome = await checkUntilPassing(input.checks, url, poll)
    after = outcome.results
    log(
      `checks after upload: ${outcome.passed ? "passed" : `failed (${failedPreviewChecks(after)})`}`,
    )
  }
  const failing = [...(gate ?? []), ...(after ?? [])].filter((check) => !check.ok)
  return {
    ...base,
    deployed: input.commit,
    url,
    state: failing.length > 0 ? "failing-checks" : "live",
    ...(gate ? { gate } : {}),
    ...(after ? { after } : {}),
    ...(failing.length > 0 ? { message: failedPreviewChecks(failing) } : {}),
  }
}

/** Deletes Preview `name` and confirms it is gone from the list; throws when it is not. */
export async function removePreviewSite(previews: Previews, name: string) {
  await previews.remove(name)
  const left = (await previews.list()).filter((preview) => preview.name === name)
  if (left.length > 0) throw new Error(`Preview ${name} is still listed after deletion`)
}

/** Pull request Previews are named `pr-<n>`; only those are swept. */
export const PULL_REQUEST_PREVIEW = /^pr-(\d+)$/
export const pullRequestPreviewName = (number: number) => `pr-${number}`

/**
 * Lists the Worker's Previews, plans with planPreviewSweep (only `pr-<n>` names are managed; open
 * PRs are kept unless past retention or capacity), deletes each removed one and confirms it gone.
 */
export async function sweepPreviews(input: {
  previews: Previews
  openPullRequests: readonly number[]
  retentionMs: number
  capacity: number
  now?: number
}) {
  const listed = await input.previews.list()
  const plan = planPreviewSweep({
    previews: listed.map((preview) => ({
      name: preview.name,
      updatedAt: Date.parse(preview.updatedAt),
    })),
    openNames: new Set(input.openPullRequests.map(pullRequestPreviewName)),
    owns: (name) => PULL_REQUEST_PREVIEW.test(name),
    now: input.now ?? Date.now(),
    retentionMs: input.retentionMs,
    capacity: input.capacity,
  })
  const failures: string[] = []
  for (const item of plan) {
    try {
      await input.previews.remove(item.name)
    } catch (error) {
      failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const after = new Set((await input.previews.list()).map((preview) => preview.name))
  const left = plan.filter((item) => after.has(item.name)).map((item) => item.name)
  return { removed: plan, left, failures }
}
