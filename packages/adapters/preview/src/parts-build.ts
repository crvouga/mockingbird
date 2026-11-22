/**
 * Builds each app of a registry into its own content-addressed part (`createPreviewPart`, written
 * to `parts/<app>/<pin>/…` next to its `part.json`) and writes the load manifest `parts.json`,
 * failing the build when a part is over its compressed-size budget. The same parts deploy, and are
 * shared across previews, with `./parts.js` (`planPreviewParts`, `deployPreviewParts`).
 * `watchPreviewParts` is the dev loop: it rebuilds only the parts whose source files changed and
 * publishes the new manifest.
 *
 * Bun / Node only (esbuild and the file system). esbuild is a peer dependency, loaded on first use.
 */
import { type FSWatcher, watch } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { digestPreviewBytes } from "./artifacts.js"
import { createPreviewPart, type PreviewPart, previewPartPath } from "./parts.js"
import {
  checkPartBudgets,
  formatPartSizes,
  gzipSize,
  PREVIEW_LOAD_MANIFEST,
  type PreviewLoadManifest,
  type PreviewPartBudgets,
} from "./parts-load.js"

/** One part to build: structurally `PreviewSystem.parts()` from `@crvouga/mockingbird-ui`. */
export type PreviewPartSource = {
  id: string
  mount?: "inline" | "iframe"
  /** The module to bundle. Parts without one keep their prebuilt `entry`. */
  source?: string
  entry?: string
  backends?: readonly string[]
  prefetch?: boolean
}

export type BuildPreviewPartsOptions = {
  /** The registry's part list (`system.parts()`). */
  parts: readonly PreviewPartSource[]
  /** Backend code to build into parts the worker host imports (id → module). */
  backends?: Record<string, string>
  /**
   * The static output directory: each part goes to `parts/<app>/<pin>/` (backends as
   * `parts/backend-<id>/<pin>/`), the load manifest is `parts.json`.
   */
  outdir: string
  /**
   * Pins the shared runtime: a string, or the built shell files whose bytes are hashed (and
   * whose gzip size is the shell's initial payload). A change forces open tabs to reload.
   */
  runtime?: string
  shell?: readonly string[]
  budgets?: PreviewPartBudgets
  /** Extra esbuild options (plugins, define, …) merged into every part build. */
  esbuild?: Record<string, unknown>
  /** Where relative paths resolve. Default `process.cwd()`. */
  workingDir?: string
  /** Receives the size table. Default `console.log`. Pass `() => {}` to silence it. */
  log?: (table: string) => void
}

/** What a build produced: the load manifest and every content-addressed part it built. */
export type BuiltPreviewParts = {
  manifest: PreviewLoadManifest
  /**
   * The parts built from a `source` (backends as `backend-<id>`), ready for
   * `createPreviewPartsManifest`, `planPreviewParts({ built })`, `deployPreviewParts` and
   * `previewPartAssetFiles`. Each part's `input` hashes the files esbuild read, so an app whose
   * sources did not change keeps its input hash, and its pin, across commits.
   */
  parts: PreviewPart[]
}

type Built = {
  manifest: PreviewLoadManifest
  parts: Map<string, PreviewPart>
  inputs: Map<string, Set<string>>
}

const hex = (bytes: Uint8Array | string) =>
  digestPreviewBytes(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)

const SAFE_ID = /^[A-Za-z0-9][\w.-]*$/

const FRAME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="./index.js"></script></body></html>\n`

async function buildOne(
  options: BuildPreviewPartsOptions,
  id: string,
  source: string,
  kind: "inline" | "iframe" | "backend",
): Promise<{ entry: string; part: PreviewPart; bytes: number; inputs: Set<string> }> {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid part id ${id}`)
  const { build } = await import("esbuild")
  const workingDir = resolve(options.workingDir ?? process.cwd())
  const outdir = resolve(workingDir, options.outdir)
  const result = await build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify: true,
    ...(options.esbuild ?? {}),
    absWorkingDir: workingDir,
    format: "esm",
    entryPoints: [resolve(workingDir, source)],
    write: false,
    metafile: true,
    outdir: join(outdir, "parts"),
  })
  const output = result.outputFiles.find((file) => file.path.endsWith(".js"))
  if (!output) throw new Error(`The part ${id} built no JavaScript`)
  const files = [{ path: "index.js", bytes: output.contents, contentType: "text/javascript" }]
  if (kind === "iframe")
    files.push({
      path: "index.html",
      bytes: new TextEncoder().encode(FRAME_HTML),
      contentType: "text/html; charset=utf-8",
    })
  const read = Object.keys(result.metafile.inputs)
    .map((input) => resolve(workingDir, input))
    .sort()
  // The input hash: the part's kind and every file esbuild read (path and SHA-256), so two
  // commits whose inputs for this app match can reuse its part without building it.
  const fingerprint: [string, string][] = []
  for (const file of read)
    fingerprint.push([
      relative(workingDir, file),
      await hex(new Uint8Array(await readFile(file).catch(() => new Uint8Array()))),
    ])
  const part = await createPreviewPart({
    app: id,
    input: await hex(JSON.stringify({ kind, inputs: fingerprint })),
    files,
  })
  const dir = join(outdir, previewPartPath(id, part.pin))
  await mkdir(dir, { recursive: true })
  for (const file of part.files) await writeFile(join(dir, file.path), file.bytes)
  // `part.json` last, as on a shared host: a directory with it is always complete.
  await writeFile(join(dir, "part.json"), part.indexBytes)
  return {
    entry: `./${previewPartPath(id, part.pin, kind === "iframe" ? "index.html" : "index.js")}`,
    part,
    bytes: await gzipSize(output.contents),
    inputs: new Set(read.filter((file) => !file.includes("node_modules"))),
  }
}

async function buildAll(
  options: BuildPreviewPartsOptions,
  previous?: Built,
  only?: Set<string>,
): Promise<Built> {
  const workingDir = resolve(options.workingDir ?? process.cwd())
  const outdir = resolve(workingDir, options.outdir)
  const inputs = new Map(previous?.inputs ?? [])
  const built = new Map<string, PreviewPart>()
  const parts: PreviewLoadManifest["parts"] = {}
  for (const part of options.parts) {
    const before = previous?.manifest.parts[part.id]
    if (before && only && !only.has(part.id)) {
      parts[part.id] = before
      const kept = previous?.parts.get(part.id)
      if (kept) built.set(part.id, kept)
      continue
    }
    const common = {
      ...(part.backends?.length ? { backends: [...part.backends] } : {}),
      ...(part.prefetch ? { prefetch: true } : {}),
    }
    if (part.source !== undefined) {
      const result = await buildOne(options, part.id, part.source, part.mount ?? "inline")
      inputs.set(part.id, result.inputs)
      built.set(part.id, result.part)
      parts[part.id] = {
        entry: result.entry,
        pin: result.part.pin,
        bytes: result.bytes,
        ...common,
      }
    } else if (part.entry !== undefined) {
      // A prebuilt part: pinned by its bytes when it is in outdir, else by its URL.
      let bytes = new Uint8Array()
      try {
        bytes = new Uint8Array(await readFile(resolve(outdir, part.entry)))
      } catch {
        /* Served from elsewhere; its URL is its identity. */
      }
      parts[part.id] = {
        entry: part.entry,
        pin: await hex(bytes.byteLength ? bytes : part.entry),
        bytes: bytes.byteLength ? await gzipSize(bytes) : 0,
        ...common,
      }
    } else throw new Error(`The part ${part.id} has neither a source nor an entry`)
  }
  const backends: NonNullable<PreviewLoadManifest["backends"]> = {}
  for (const [id, source] of Object.entries(options.backends ?? {})) {
    const key = `backend:${id}`
    const app = `backend-${id}`
    const before = previous?.manifest.backends?.[id]
    if (before && only && !only.has(key)) {
      backends[id] = before
      const kept = previous?.parts.get(app)
      if (kept) built.set(app, kept)
      continue
    }
    const result = await buildOne(options, app, source, "backend")
    inputs.set(key, result.inputs)
    built.set(app, result.part)
    backends[id] = { entry: result.entry, pin: result.part.pin, bytes: result.bytes }
  }
  let shellBytes: number | undefined
  let shellPin = ""
  if (options.shell?.length) {
    shellBytes = 0
    for (const file of options.shell) {
      const bytes = new Uint8Array(await readFile(resolve(outdir, file)))
      shellBytes += await gzipSize(bytes)
      shellPin += await hex(bytes)
    }
  }
  const manifest: PreviewLoadManifest = {
    version: 1,
    runtime: options.runtime ?? (shellPin ? await hex(shellPin) : "runtime"),
    ...(shellBytes === undefined ? {} : { shellBytes }),
    parts,
    ...(Object.keys(backends).length ? { backends } : {}),
  }
  ;(options.log ?? console.log)(formatPartSizes(manifest, options.budgets))
  if (options.budgets) checkPartBudgets(manifest, options.budgets)
  await mkdir(outdir, { recursive: true })
  await writeFile(
    join(outdir, PREVIEW_LOAD_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  )
  return { manifest, parts: built, inputs }
}

/**
 * Builds every part with a `source` into `outdir/parts/<app>/<pin>/` (`index.js`, plus
 * `index.html` for iframe apps, plus `part.json`), measures each one gzip-compressed, prints the
 * size table, writes `parts.json`, and throws `PreviewPartBudgetError` when the shell or a part
 * is over budget. Returns the load manifest; `buildPreviewPartSet` also returns the parts.
 */
export async function buildPreviewParts(
  options: BuildPreviewPartsOptions,
): Promise<PreviewLoadManifest> {
  return (await buildAll(options)).manifest
}

/**
 * `buildPreviewParts`, also returning the content-addressed parts it built, for a deploy that
 * shares them across previews (`createPreviewPartsManifest`, `deployPreviewParts`).
 */
export async function buildPreviewPartSet(
  options: BuildPreviewPartsOptions,
): Promise<BuiltPreviewParts> {
  const built = await buildAll(options)
  return { manifest: built.manifest, parts: [...built.parts.values()] }
}

export type PreviewPartsWatcher = {
  /** Resolves with the first manifest. */
  ready: Promise<PreviewLoadManifest>
  manifest(): PreviewLoadManifest | undefined
  /** Called with each new manifest (pass this to `partUpdatesResponse`). */
  subscribe(listener: (manifest: PreviewLoadManifest) => void): () => void
  /** Every rebuild so far: the part ids rebuilt (backends as `backend:<id>`) and any error. */
  rebuilds(): { parts: string[]; error?: string }[]
  close(): void
}

/**
 * The dev loop: builds once, then watches each part's own source files (from esbuild's metafile)
 * and rebuilds only the parts a change touches, publishing the new manifest to subscribers. A
 * file shared by two parts rebuilds both. A failed rebuild keeps the last good manifest.
 */
export function watchPreviewParts(
  options: BuildPreviewPartsOptions & { debounceMs?: number },
): PreviewPartsWatcher {
  const listeners = new Set<(manifest: PreviewLoadManifest) => void>()
  const history: { parts: string[]; error?: string }[] = []
  const watchers = new Map<string, FSWatcher>()
  let built: Built | undefined
  let closed = false
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()
  const partsOf = (file: string) =>
    [...(built?.inputs ?? [])].filter(([, files]) => files.has(file)).map(([id]) => id)
  const rewatch = () => {
    const dirs = new Set(
      [...(built?.inputs.values() ?? [])].flatMap((files) =>
        [...files].map((file) => dirname(file)),
      ),
    )
    for (const [dir, watcher] of watchers)
      if (!dirs.has(dir)) {
        watcher.close()
        watchers.delete(dir)
      }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue
      try {
        watchers.set(
          dir,
          watch(dir, (_event, name) => {
            if (closed || !name) return
            const file = resolve(dir, name.toString())
            for (const id of partsOf(file)) pending.add(id)
            if (pending.size === 0) return
            clearTimeout(timer)
            timer = setTimeout(flush, options.debounceMs ?? 100)
          }),
        )
      } catch {
        /* A directory that vanished is picked up again after the next build. */
      }
    }
  }
  const flush = () => {
    const only = pending
    pending = new Set()
    running = running.then(async () => {
      if (closed || !built) return
      try {
        built = await buildAll(options, built, only)
        history.push({ parts: [...only].sort() })
        rewatch()
        for (const listener of listeners) listener(built.manifest)
      } catch (error) {
        history.push({
          parts: [...only].sort(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }
  const ready = buildAll(options).then((first) => {
    built = first
    if (!closed) rewatch()
    return first.manifest
  })
  return {
    ready,
    manifest: () => built?.manifest,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    rebuilds: () => history.map((entry) => ({ ...entry, parts: [...entry.parts] })),
    close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      listeners.clear()
    },
  }
}
