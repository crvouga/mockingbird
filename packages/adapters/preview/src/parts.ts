/**
 * Content-addressed preview parts: each app of a preview is published once under
 * `parts/<app>/<pin>/…`, immutable and shared by every preview on the same host, and a preview is
 * a small manifest mapping apps to pins. A pull request rebuilds only the apps whose input hash
 * its base does not know, and uploads only the pins the host lacks.
 *
 * Portable: Web Crypto and Fetch only.
 */
import { digestPreviewBytes, loadPreviewArtifact, type PreviewDownload } from "./artifacts.js"
import type { PreviewAssetFile } from "./cloudflare.js"

/** One output file of a part, as built. `path` is relative to the part's directory. */
export type PreviewPartFile = { path: string; bytes: Uint8Array; contentType: string }
/** The part index (`part.json`), whose SHA-256 is the part's pin. */
export type PreviewPartIndex = {
  format: 1
  files: { path: string; bytes: number; sha256: string; contentType: string }[]
}
/** A manifest entry: the input hash it was built from, its pin and the index's byte count. */
export type PreviewPartRef = { input: string; pin: string; bytes: number }
/** A built part: its manifest entry, its index's exact bytes and its files. */
export type PreviewPart = PreviewPartRef & {
  app: string
  index: PreviewPartIndex
  indexBytes: Uint8Array
  files: PreviewPartFile[]
}
/** A preview: the commit it ships and the pin of every app part. */
export type PreviewPartsManifest = {
  format: 1
  commit: string
  parts: Record<string, PreviewPartRef>
}
/** A complete part on shared storage (its `part.json` is present). */
export type HostedPreviewPart = { app: string; pin: string; updatedAt: number }

/**
 * Where a preview's parts live. With `listParts`, parts are shared across previews and only
 * missing pins are uploaded; without it (a plain static deploy) every part is uploaded each time.
 */
export type PreviewPartsHost = {
  listParts?: () => Promise<HostedPreviewPart[]>
  /** Idempotent: writes the files, then `part.json` last, so a listed part is always complete. */
  uploadPart: (part: PreviewPart, preview: string) => Promise<void>
  /** Called after every part the manifest names is uploaded. */
  uploadManifest: (preview: string, manifest: PreviewPartsManifest) => Promise<void>
  deletePart?: (part: { app: string; pin: string }) => Promise<void>
}

/** The manifest's file name next to the shell. */
export const PREVIEW_PARTS_MANIFEST = "preview-parts.json"
const HEX = /^[0-9a-f]{64}$/
const APP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const key = (app: string, pin: string) => `${app}/${pin}`

const assertApp = (app: string) => {
  if (!APP.test(app)) throw new Error(`Invalid preview part app ${JSON.stringify(app)}`)
}
const assertInput = (input: unknown) => {
  if (typeof input !== "string" || !input || input.length > 256)
    throw new Error("Invalid preview part input hash")
}
const assertPath = (path: string) => {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path === "part.json"
  )
    throw new Error(`Invalid preview part file path ${JSON.stringify(path)}`)
}

/** The published path of a part's directory (or one of its files): `parts/<app>/<pin>/<file>`. */
export function previewPartPath(app: string, pin: string, file = "") {
  assertApp(app)
  if (!HEX.test(pin)) throw new Error("Invalid preview part pin")
  if (file && file !== "part.json") assertPath(file)
  return `parts/${app}/${pin}/${file}`
}

/**
 * Builds a part from an app's output files. The pin is the SHA-256 of the canonical `part.json`
 * (each file's path, size, SHA-256 and content type), so it depends only on the output: two
 * builds that produce the same files produce the same pin, whatever their input hash.
 */
export async function createPreviewPart(options: {
  app: string
  input: string
  files: PreviewPartFile[]
}): Promise<PreviewPart> {
  assertApp(options.app)
  assertInput(options.input)
  const seen = new Set<string>()
  const files = [...options.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const entries: PreviewPartIndex["files"] = []
  for (const file of files) {
    assertPath(file.path)
    if (seen.has(file.path)) throw new Error(`Duplicate preview part file ${file.path}`)
    if (!file.contentType) throw new Error(`Preview part file ${file.path} needs a content type`)
    seen.add(file.path)
    entries.push({
      path: file.path,
      bytes: file.bytes.byteLength,
      sha256: await digestPreviewBytes(file.bytes),
      contentType: file.contentType,
    })
  }
  const index: PreviewPartIndex = { format: 1, files: entries }
  const indexBytes = new TextEncoder().encode(JSON.stringify(index))
  return {
    app: options.app,
    input: options.input,
    pin: await digestPreviewBytes(indexBytes),
    bytes: indexBytes.byteLength,
    index,
    indexBytes,
    files,
  }
}

/** Validates a preview parts manifest. */
export function parsePreviewPartsManifest(value: unknown): PreviewPartsManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preview parts manifest")
  const item = value as Partial<PreviewPartsManifest>
  if (
    item.format !== 1 ||
    typeof item.commit !== "string" ||
    !item.commit ||
    !item.parts ||
    typeof item.parts !== "object" ||
    Array.isArray(item.parts)
  )
    throw new Error("Invalid preview parts manifest")
  const parts: Record<string, PreviewPartRef> = {}
  for (const [app, ref] of Object.entries(item.parts)) {
    assertApp(app)
    if (
      !ref ||
      typeof ref !== "object" ||
      typeof ref.pin !== "string" ||
      !HEX.test(ref.pin) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1
    )
      throw new Error(`Invalid preview parts manifest entry ${app}`)
    assertInput(ref.input)
    parts[app] = { input: ref.input, pin: ref.pin, bytes: ref.bytes }
  }
  return { format: 1, commit: item.commit, parts }
}

/** The manifest for a commit from its parts (built or reused). */
export function createPreviewPartsManifest(options: {
  commit: string
  parts: Record<string, PreviewPartRef>
}): PreviewPartsManifest {
  const sorted = Object.fromEntries(
    Object.entries(options.parts)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([app, ref]) => [app, { input: ref.input, pin: ref.pin, bytes: ref.bytes }]),
  )
  return parsePreviewPartsManifest({ format: 1, commit: options.commit, parts: sorted })
}

export type PreviewPartsPlan = {
  /** Apps to build: their input hash is unknown to the base, or the base's pin left the host. */
  build: string[]
  /** Every part whose pin is known (reused from the base or built), by app. */
  parts: Record<string, PreviewPartRef>
  /** Known pins the host lacks (every known pin without shared storage), once each. */
  upload: { app: string; pin: string }[]
  /** Whether the host shares parts across previews. */
  shared: boolean
}

/**
 * A pure plan. `candidate` maps every app of the new preview to its input hash (from the build
 * tool). `built` are parts already built for this candidate. `hosted` lists the complete parts on
 * shared storage; leave it out for a host without shared storage (every part is then uploaded).
 */
export function planPreviewParts(options: {
  base?: PreviewPartsManifest | undefined
  candidate: Record<string, string>
  built?: readonly PreviewPart[]
  hosted?: readonly { app: string; pin: string }[] | undefined
}): PreviewPartsPlan {
  const base = options.base ? parsePreviewPartsManifest(options.base) : undefined
  const hosted = options.hosted ? new Set(options.hosted.map((p) => key(p.app, p.pin))) : undefined
  const built = new Map<string, PreviewPart>()
  for (const part of options.built ?? []) {
    if (built.has(part.app)) throw new Error(`Preview part ${part.app} was built twice`)
    built.set(part.app, part)
  }
  const build: string[] = []
  const parts: Record<string, PreviewPartRef> = {}
  for (const app of Object.keys(options.candidate).sort()) {
    assertApp(app)
    const input = options.candidate[app] as string
    assertInput(input)
    const fresh = built.get(app)
    if (fresh) {
      if (fresh.input !== input)
        throw new Error(`Preview part ${app} was built from a different input`)
      parts[app] = { input, pin: fresh.pin, bytes: fresh.bytes }
      continue
    }
    const previous = base?.parts[app]
    if (previous && previous.input === input && (!hosted || hosted.has(key(app, previous.pin))))
      parts[app] = { ...previous }
    else build.push(app)
  }
  for (const app of built.keys())
    if (!(app in options.candidate)) throw new Error(`Preview part ${app} is not a candidate app`)
  const upload: { app: string; pin: string }[] = []
  const queued = new Set<string>()
  for (const [app, ref] of Object.entries(parts)) {
    const id = key(app, ref.pin)
    if (queued.has(id) || hosted?.has(id)) continue
    queued.add(id)
    upload.push({ app, pin: ref.pin })
  }
  return { build, parts, upload, shared: hosted !== undefined }
}

/**
 * Publishes a preview: uploads the parts its manifest names that the host lacks, then the
 * manifest. A pin already on the host is never uploaded again, so a retry after a partial failure
 * finishes the job. Parts the host lacks must be in `built` (the bytes to upload).
 */
export async function deployPreviewParts(options: {
  host: PreviewPartsHost
  preview: string
  manifest: PreviewPartsManifest
  built?: readonly PreviewPart[]
}) {
  const manifest = parsePreviewPartsManifest(options.manifest)
  if (!options.preview) throw new Error("Preview name is required")
  const hosted = options.host.listParts ? await options.host.listParts() : undefined
  const present = new Set((hosted ?? []).map((part) => key(part.app, part.pin)))
  const available = new Map((options.built ?? []).map((part) => [key(part.app, part.pin), part]))
  const parts: PreviewPart[] = []
  const queued = new Set<string>()
  for (const [app, ref] of Object.entries(manifest.parts)) {
    const id = key(app, ref.pin)
    if (present.has(id) || queued.has(id)) continue
    const part = available.get(id)
    if (!part)
      throw new Error(`Preview part ${app}@${ref.pin} is not on the host and was not built`)
    queued.add(id)
    parts.push(part)
  }
  for (const part of parts) await options.host.uploadPart(part, options.preview)
  await options.host.uploadManifest(options.preview, manifest)
  return {
    uploaded: parts.map(({ app, pin }) => ({ app, pin })),
    reused: Object.entries(manifest.parts)
      .filter(([app]) => !parts.some((part) => part.app === app))
      .map(([app, ref]) => ({ app, pin: ref.pin })),
    shared: hosted !== undefined,
  }
}

/**
 * A pure garbage-collection plan: the hosted parts no live manifest references and that are
 * older than `retentionMs` (which also covers a deploy that has uploaded parts but not yet its
 * manifest). `removed` names previews being removed (for example `planPreviewSweep`'s result),
 * whose manifests no longer keep parts alive. An invalid manifest throws: nothing is deleted on an
 * uncertain reference.
 */
export function planPreviewPartSweep(options: {
  parts: readonly HostedPreviewPart[]
  manifests: readonly { name: string; manifest: unknown }[]
  removed?: Iterable<string>
  now: number
  retentionMs: number
}) {
  if (!Number.isFinite(options.now) || !Number.isFinite(options.retentionMs))
    throw new Error("Invalid preview part retention policy")
  if (options.retentionMs < 0) throw new Error("Invalid preview part retention policy")
  const removed = new Set(options.removed ?? [])
  const referenced = new Set<string>()
  for (const { name, manifest } of options.manifests) {
    const parsed = parsePreviewPartsManifest(manifest)
    if (removed.has(name)) continue
    for (const [app, ref] of Object.entries(parsed.parts)) referenced.add(key(app, ref.pin))
  }
  return options.parts
    .filter((part) => {
      if (!Number.isFinite(part.updatedAt)) throw new Error("Invalid preview part timestamp")
      return (
        !referenced.has(key(part.app, part.pin)) &&
        options.now - part.updatedAt > options.retentionMs
      )
    })
    .map(({ app, pin }) => ({ app, pin, reason: "unreferenced" as const }))
    .sort((a, b) => key(a.app, a.pin).localeCompare(key(b.app, b.pin)))
}

/** Runs `planPreviewPartSweep` against a shared host. A host without shared storage is a no-op. */
export async function sweepPreviewParts(options: {
  host: PreviewPartsHost
  manifests: readonly { name: string; manifest: unknown }[]
  removed?: Iterable<string>
  now: number
  retentionMs: number
}) {
  const { listParts, deletePart } = options.host
  if (!listParts || !deletePart) return []
  const plan = planPreviewPartSweep({ ...options, parts: await listParts() })
  for (const part of plan) await deletePart({ app: part.app, pin: part.pin })
  return plan
}

/**
 * Loads one app's part for the shell and verifies it against its pin before anything executes:
 * `part.json` must hash to the pin, and every file must match the size and SHA-256 it lists (the
 * same checks as `loadPreviewArtifact`). `baseUrl` is the host root that holds `parts/`.
 */
export async function loadPreviewPart(
  manifest: unknown,
  app: string,
  options: {
    baseUrl: string | URL
    fetch?: PreviewDownload
    maximumBytes?: number
    signal?: AbortSignal
  },
) {
  const parsed = parsePreviewPartsManifest(manifest)
  const ref = parsed.parts[app]
  if (!ref) throw new Error(`Preview part ${app} is not in the manifest`)
  const load = (path: string, sha256: string, bytes: number) =>
    loadPreviewArtifact(
      {
        format: 1,
        commit: ref.pin,
        sha256,
        bytes,
        encoding: "identity",
        url: new URL(path, options.baseUrl).href,
      },
      {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.maximumBytes !== undefined ? { maximumBytes: options.maximumBytes } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    )
  const indexBytes = await load(previewPartPath(app, ref.pin, "part.json"), ref.pin, ref.bytes)
  let index: PreviewPartIndex
  try {
    index = JSON.parse(new TextDecoder().decode(indexBytes)) as PreviewPartIndex
  } catch {
    throw new Error("Invalid preview part index")
  }
  if (index.format !== 1 || !Array.isArray(index.files))
    throw new Error("Invalid preview part index")
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>()
  for (const file of index.files) {
    assertPath(file.path)
    files.set(file.path, {
      bytes: await load(previewPartPath(app, ref.pin, file.path), file.sha256, file.bytes),
      contentType: file.contentType,
    })
  }
  return { app, pin: ref.pin, index, files }
}

/**
 * A preview's parts and manifest as static files (`/parts/<app>/<pin>/…` and
 * `/preview-parts.json`), for a static deploy such as `createCloudflarePreviews().deploy`, whose
 * asset upload sends only content the host does not already hold.
 */
export function previewPartAssetFiles(
  manifest: PreviewPartsManifest,
  parts: readonly PreviewPart[],
): PreviewAssetFile[] {
  const parsed = parsePreviewPartsManifest(manifest)
  const files: PreviewAssetFile[] = []
  for (const [app, ref] of Object.entries(parsed.parts)) {
    const part = parts.find((item) => item.app === app && item.pin === ref.pin)
    if (!part) throw new Error(`Preview part ${app}@${ref.pin} was not provided`)
    for (const file of part.files)
      files.push({
        path: `/${previewPartPath(app, ref.pin, file.path)}`,
        bytes: file.bytes,
        contentType: file.contentType,
      })
    files.push({
      path: `/${previewPartPath(app, ref.pin, "part.json")}`,
      bytes: part.indexBytes,
      contentType: "application/json",
    })
  }
  files.push({
    path: `/${PREVIEW_PARTS_MANIFEST}`,
    bytes: new TextEncoder().encode(JSON.stringify(parsed)),
    contentType: "application/json",
  })
  return files
}
