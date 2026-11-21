/**
 * Builds each app of a registry into its own content-pinned part and writes `parts.json`, failing
 * the build when a part is over its compressed-size budget. `watchPreviewParts` is the dev loop:
 * it rebuilds only the parts whose source files changed and publishes the new manifest.
 *
 * Bun / Node only (esbuild and the file system). esbuild is a peer dependency, loaded on first use.
 */
import { type FSWatcher, watch } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  checkPartBudgets,
  formatPartSizes,
  gzipSize,
  type PreviewPartBudgets,
  type PreviewPartsManifest,
} from "./parts.js"

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
  /** The static output directory; parts go under `parts/`, the manifest is `parts.json`. */
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

type Built = { manifest: PreviewPartsManifest; inputs: Map<string, Set<string>> }

const hex = async (bytes: Uint8Array | string) => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource))
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const SAFE_ID = /^[A-Za-z0-9][\w.-]*$/

async function buildOne(
  options: BuildPreviewPartsOptions,
  id: string,
  source: string,
  kind: "inline" | "iframe" | "backend",
): Promise<{ entry: string; pin: string; bytes: number; inputs: Set<string> }> {
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
  const pin = await hex(output.contents)
  const dir = join(outdir, "parts")
  await mkdir(dir, { recursive: true })
  const script = `${id}-${pin}.js`
  await writeFile(join(dir, script), output.contents)
  let entry = `./parts/${script}`
  if (kind === "iframe") {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="./${script}"></script></body></html>\n`
    await writeFile(join(dir, `${id}-${pin}.html`), html, "utf8")
    entry = `./parts/${id}-${pin}.html`
  }
  const inputs = new Set(
    Object.keys(result.metafile.inputs)
      .filter((input) => !input.includes("node_modules"))
      .map((input) => resolve(workingDir, input)),
  )
  return { entry, pin, bytes: await gzipSize(output.contents), inputs }
}

async function buildAll(options: BuildPreviewPartsOptions, previous?: Built, only?: Set<string>) {
  const workingDir = resolve(options.workingDir ?? process.cwd())
  const outdir = resolve(workingDir, options.outdir)
  const inputs = new Map(previous?.inputs ?? [])
  const parts: PreviewPartsManifest["parts"] = {}
  for (const part of options.parts) {
    const before = previous?.manifest.parts[part.id]
    if (before && only && !only.has(part.id)) {
      parts[part.id] = before
      continue
    }
    const common = {
      ...(part.backends?.length ? { backends: [...part.backends] } : {}),
      ...(part.prefetch ? { prefetch: true } : {}),
    }
    if (part.source !== undefined) {
      const built = await buildOne(options, part.id, part.source, part.mount ?? "inline")
      inputs.set(part.id, built.inputs)
      parts[part.id] = { entry: built.entry, pin: built.pin, bytes: built.bytes, ...common }
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
  const backends: NonNullable<PreviewPartsManifest["backends"]> = {}
  for (const [id, source] of Object.entries(options.backends ?? {})) {
    const key = `backend:${id}`
    const before = previous?.manifest.backends?.[id]
    if (before && only && !only.has(key)) {
      backends[id] = before
      continue
    }
    const built = await buildOne(options, `backend-${id}`, source, "backend")
    inputs.set(key, built.inputs)
    backends[id] = { entry: built.entry, pin: built.pin, bytes: built.bytes }
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
  const manifest: PreviewPartsManifest = {
    version: 1,
    runtime: options.runtime ?? (shellPin ? await hex(shellPin) : "runtime"),
    ...(shellBytes === undefined ? {} : { shellBytes }),
    parts,
    ...(Object.keys(backends).length ? { backends } : {}),
  }
  ;(options.log ?? console.log)(formatPartSizes(manifest, options.budgets))
  if (options.budgets) checkPartBudgets(manifest, options.budgets)
  await mkdir(outdir, { recursive: true })
  await writeFile(join(outdir, "parts.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return { manifest, inputs }
}

/**
 * Builds every part with a `source` into `outdir/parts/<id>-<pin>.js` (iframe apps also get an
 * `.html` document), measures each one gzip-compressed, prints the size table, writes
 * `parts.json`, and throws `PreviewPartBudgetError` when the shell or a part is over budget.
 */
export async function buildPreviewParts(
  options: BuildPreviewPartsOptions,
): Promise<PreviewPartsManifest> {
  return (await buildAll(options)).manifest
}

export type PreviewPartsWatcher = {
  /** Resolves with the first manifest. */
  ready: Promise<PreviewPartsManifest>
  manifest(): PreviewPartsManifest | undefined
  /** Called with each new manifest (pass this to `partUpdatesResponse`). */
  subscribe(listener: (manifest: PreviewPartsManifest) => void): () => void
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
  const listeners = new Set<(manifest: PreviewPartsManifest) => void>()
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
