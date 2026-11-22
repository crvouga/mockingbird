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
  /**
   * Where each part's `node_modules` code goes. `"bundle"` (default): into every part that uses
   * it. `"shared"`: into one content-addressed dependency part (`parts/shared-deps/<pin>/`) that
   * every part imports by URL, so a part's build reads only its own sources, a rebuild re-emits
   * only the part that changed, and the browser's module and compiled-code caches keep the
   * dependencies across rebuilds and visits. See the README's "Shared dependencies".
   */
  dependencies?: "bundle" | "shared"
}

/** The part id of the shared dependency part (`dependencies: "shared"`). Reserved. */
export const PREVIEW_SHARED_DEPS_PART = "shared-deps"

/** The global the parts register CommonJS dependencies under (`dependencies: "shared"`). */
const REGISTRY = "__mockingbirdSharedDeps"

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

/** One `node_modules` module the shared dependency part serves. */
type SharedDep = {
  /** Its file in the dependency part. */
  file: string
  /** CommonJS: parts reach it through the registry (its `module.exports`), never a named import. */
  cjs: boolean
}

/** The shared dependency part: every `node_modules` module a part imports, by resolved path. */
type SharedDeps = { pin: string; modules: Map<string, SharedDep>; part: PreviewPart; bytes: number }

type Built = {
  manifest: PreviewLoadManifest
  parts: Map<string, PreviewPart>
  inputs: Map<string, Set<string>>
  deps?: SharedDeps
  /** Per part (backends as `backend:<id>`): the CommonJS-registered modules its banner imports. */
  registered?: Map<string, string[]>
}

const NODE_MODULES = /[\\/]node_modules[\\/]/
const SCRIPT = /\.(?:[cm]?[jt]sx?|json)$/i

/** A JavaScript string literal safe in generated module source. */
const literal = (value: string): string =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

/** What one part build learned about its `node_modules` imports. */
type DepsScan = {
  /** Modules no shared dependency part serves yet. */
  missing: Set<string>
  /** Modules it reaches through the registry (CommonJS, or `require()`d). */
  registered: Set<string>
}

/**
 * Sends every import that resolves into `node_modules` to the shared dependency part: an ES module
 * imported with `import` stays an `import` of its URL; anything else (CommonJS, `require()`) reads
 * the module from the registry the part's banner fills.
 */
const sharedDepsPlugin = (
  deps: SharedDeps | undefined,
  scan: DepsScan,
  urlOf: (file: string) => string,
) => ({
  name: "mockingbird-shared-dependencies",
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: {
        path: string
        importer: string
        resolveDir: string
        kind: string
        pluginData?: unknown
      }) => unknown,
    ): void
    onLoad(
      options: { filter: RegExp; namespace: string },
      callback: (args: { path: string }) => unknown,
    ): void
    resolve(
      path: string,
      options: { kind: string; resolveDir: string; importer: string; pluginData?: unknown },
    ): Promise<{ path: string; namespace: string; external: boolean; errors: unknown[] }>
  }) {
    const skip = Symbol.for("mockingbird-shared-dependencies")
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.kind === "entry-point" || args.kind === "require-resolve") return undefined
      if ((args.pluginData as Record<symbol, unknown> | undefined)?.[skip]) return undefined
      const resolved = await build.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: { [skip]: true },
      })
      if (resolved.errors.length > 0 || resolved.external || resolved.namespace !== "file")
        return undefined
      if (!NODE_MODULES.test(resolved.path) || !SCRIPT.test(resolved.path)) return undefined
      const dep = deps?.modules.get(resolved.path)
      if (!dep) {
        // Not in the dependency part yet: this build is only a scan.
        scan.missing.add(resolved.path)
        return { path: args.path, external: true }
      }
      if (!dep.cjs && (args.kind === "import-statement" || args.kind === "dynamic-import"))
        return { path: urlOf(dep.file), external: true }
      scan.registered.add(resolved.path)
      return { path: resolved.path, namespace: "mockingbird-shared-dep" }
    })
    build.onLoad({ filter: /.*/, namespace: "mockingbird-shared-dep" }, (args) => ({
      contents: `module.exports = globalThis[${literal(REGISTRY)}][${literal(deps?.modules.get(args.path)?.file ?? "")}]`,
      loader: "js",
    }))
  },
})

/** The banner that fills the registry for the modules a part reaches through it. */
const registryBanner = (
  deps: SharedDeps,
  paths: readonly string[],
  urlOf: (file: string) => string,
) =>
  paths
    .map((path, index) => {
      const dep = deps.modules.get(path)
      if (!dep) return ""
      const name = `__mbDep${index}`
      return `import * as ${name} from ${literal(urlOf(dep.file))};(globalThis[${literal(REGISTRY)}] ??= Object.create(null))[${literal(dep.file)}] = ${dep.cjs ? `${name}.default` : name};`
    })
    .join("")

const hex = (bytes: Uint8Array | string) =>
  digestPreviewBytes(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)

const SAFE_ID = /^[A-Za-z0-9][\w.-]*$/

const FRAME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="./index.js"></script></body></html>\n`

type BuildOneResult = { entry: string; part: PreviewPart; bytes: number; inputs: Set<string> }

async function buildOne(
  options: BuildPreviewPartsOptions,
  id: string,
  source: string,
  kind: "inline" | "iframe" | "backend",
  shared?: { deps: SharedDeps | undefined; registered: readonly string[] },
): Promise<(BuildOneResult & { registered: string[] }) | { missing: Set<string> }> {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid part id ${id}`)
  const { build } = await import("esbuild")
  const workingDir = resolve(options.workingDir ?? process.cwd())
  const outdir = resolve(workingDir, options.outdir)
  const extra = (options.esbuild ?? {}) as { plugins?: unknown[]; banner?: { js?: string } }
  // A part is served from parts/<app>/<pin>/, the dependency part from parts/shared-deps/<pin>/.
  const urlOf = (file: string) => `../../${PREVIEW_SHARED_DEPS_PART}/${shared?.deps?.pin}/${file}`
  const scan: DepsScan = { missing: new Set(), registered: new Set() }
  const banner =
    shared?.deps && shared.registered.length > 0
      ? registryBanner(shared.deps, shared.registered, urlOf)
      : ""
  const result = await build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify: true,
    ...extra,
    ...(shared
      ? {
          plugins: [sharedDepsPlugin(shared.deps, scan, urlOf), ...((extra.plugins ?? []) as [])],
          ...(banner
            ? { banner: { ...extra.banner, js: `${banner}${extra.banner?.js ?? ""}` } }
            : {}),
        }
      : {}),
    absWorkingDir: workingDir,
    format: "esm",
    entryPoints: [resolve(workingDir, source)],
    write: false,
    metafile: true,
    outdir: join(outdir, "parts"),
  } as Parameters<typeof build>[0] & { write: false; metafile: true })
  if (shared) {
    if (scan.missing.size > 0) return { missing: scan.missing }
    const wanted = [...scan.registered].sort()
    // The banner must import exactly what the code reads from the registry: build again with it.
    if (wanted.join("\n") !== [...shared.registered].sort().join("\n"))
      return buildOne(options, id, source, kind, { deps: shared.deps, registered: wanted })
  }
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
    .filter((input) => !input.includes(":"))
    .map((input) => resolve(workingDir, input))
    .sort()
  // The input hash: the part's kind and every file esbuild read (path and SHA-256), so two
  // commits whose inputs for this app match can reuse its part without building it. With shared
  // dependencies the dependency part's pin is an input too (the part imports it by URL).
  const fingerprint: [string, string][] = []
  for (const file of read)
    fingerprint.push([
      relative(workingDir, file),
      await hex(new Uint8Array(await readFile(file).catch(() => new Uint8Array()))),
    ])
  const part = await createPreviewPart({
    app: id,
    input: await hex(
      JSON.stringify({
        kind,
        inputs: fingerprint,
        ...(shared?.deps ? { dependencies: shared.deps.pin } : {}),
      }),
    ),
    files,
  })
  await writePart(outdir, part)
  return {
    entry: `./${previewPartPath(id, part.pin, kind === "iframe" ? "index.html" : "index.js")}`,
    part,
    bytes: await gzipSize(output.contents),
    inputs: new Set(read.filter((file) => !NODE_MODULES.test(file))),
    registered: [...scan.registered].sort(),
  }
}

const writePart = async (outdir: string, part: PreviewPart) => {
  const dir = join(outdir, previewPartPath(part.app, part.pin))
  await mkdir(dir, { recursive: true })
  for (const file of part.files) {
    await mkdir(dirname(join(dir, file.path)), { recursive: true })
    await writeFile(join(dir, file.path), file.bytes)
  }
  // `part.json` last, as on a shared host: a directory with it is always complete.
  await writeFile(join(dir, "part.json"), part.indexBytes)
}

/**
 * Builds the shared dependency part: one ES module per `node_modules` module the parts import
 * (named after its path, so a part's import URL does not move when others are added), plus the
 * chunks they share.
 */
async function buildSharedDeps(
  options: BuildPreviewPartsOptions,
  modules: ReadonlySet<string>,
): Promise<SharedDeps> {
  const { build } = await import("esbuild")
  const workingDir = resolve(options.workingDir ?? process.cwd())
  const outdir = resolve(workingDir, options.outdir)
  const names = new Map<string, string>()
  for (const path of [...modules].sort()) {
    const base = relative(workingDir, path)
      .replace(/^(?:\.\.[\\/])+/, "")
      .split(/(?:^|[\\/])node_modules[\\/]/)
      .at(-1) as string
    const readable = base
      .replace(/\.[^./\\]+$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .slice(-60)
    names.set(`${readable}-${(await hex(relative(workingDir, path))).slice(0, 10)}`, path)
  }
  const result = await build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify: true,
    ...(options.esbuild ?? {}),
    absWorkingDir: workingDir,
    format: "esm",
    splitting: true,
    entryPoints: Object.fromEntries(names),
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    assetNames: "asset-[hash]",
    outdir: join(outdir, "parts", PREVIEW_SHARED_DEPS_PART),
    write: false,
    metafile: true,
  } as Parameters<typeof build>[0] & { write: false; metafile: true })
  const base = join(outdir, "parts", PREVIEW_SHARED_DEPS_PART)
  const files = result.outputFiles.map((file) => ({
    path: relative(base, file.path).split("\\").join("/"),
    bytes: file.contents,
    contentType: file.path.endsWith(".css")
      ? "text/css; charset=utf-8"
      : file.path.endsWith(".map")
        ? "application/json"
        : "text/javascript",
  }))
  const deps = new Map<string, SharedDep>()
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    if (!output.entryPoint) continue
    const name = relative(base, resolve(workingDir, file)).split("\\").join("/")
    const path = names.get(name.replace(/\.js$/, ""))
    if (path === undefined) continue
    const format = result.metafile.inputs[output.entryPoint]?.format
    deps.set(path, { file: name, cjs: format === "cjs" })
  }
  const part = await createPreviewPart({
    app: PREVIEW_SHARED_DEPS_PART,
    input: await hex(JSON.stringify([...names.values()].map((path) => relative(workingDir, path)))),
    files,
  })
  await writePart(outdir, part)
  let bytes = 0
  for (const file of files) bytes += await gzipSize(file.bytes)
  return { pin: part.pin, modules: deps, part, bytes }
}

/** A round of part builds met `node_modules` modules the dependency part does not serve yet. */
class MissingSharedDeps extends Error {
  constructor(readonly missing: Set<string>) {
    super(`${missing.size} dependencies are not in the shared dependency part yet`)
  }
}

async function buildAll(
  options: BuildPreviewPartsOptions,
  previous?: Built,
  only?: Set<string>,
): Promise<Built> {
  if (options.dependencies !== "shared") return buildRound(options, previous, only)
  if (
    options.parts.some((part) => part.id === PREVIEW_SHARED_DEPS_PART) ||
    Object.keys(options.backends ?? {}).some((id) => `backend-${id}` === PREVIEW_SHARED_DEPS_PART)
  )
    throw new Error(`The part id ${PREVIEW_SHARED_DEPS_PART} is reserved for shared dependencies`)
  let deps = previous?.deps
  let scope = only
  for (let round = 0; ; round++) {
    try {
      return await buildRound(options, previous, scope, deps)
    } catch (error) {
      if (!(error instanceof MissingSharedDeps) || round >= 2) throw error
      // New dependencies: a new dependency part, and every part rebuilt to import its new pin.
      deps = await buildSharedDeps(
        options,
        new Set([...(deps?.modules.keys() ?? []), ...error.missing]),
      )
      scope = undefined
    }
  }
}

async function buildRound(
  options: BuildPreviewPartsOptions,
  previous?: Built,
  only?: Set<string>,
  deps?: SharedDeps,
): Promise<Built> {
  const workingDir = resolve(options.workingDir ?? process.cwd())
  const outdir = resolve(workingDir, options.outdir)
  const inputs = new Map(previous?.inputs ?? [])
  const built = new Map<string, PreviewPart>()
  const parts: PreviewLoadManifest["parts"] = {}
  const shared = options.dependencies === "shared"
  const registered = new Map(previous?.registered ?? [])
  const missing = new Set<string>()
  /** Builds one part; with shared dependencies, collects what the dependency part lacks. */
  const one = async (
    key: string,
    app: string,
    source: string,
    kind: "inline" | "iframe" | "backend",
  ) => {
    const result = await buildOne(
      options,
      app,
      source,
      kind,
      shared ? { deps, registered: registered.get(key) ?? [] } : undefined,
    )
    if ("missing" in result) {
      for (const path of result.missing) missing.add(path)
      return undefined
    }
    registered.set(key, result.registered)
    return result
  }
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
      const result = await one(part.id, part.id, part.source, part.mount ?? "inline")
      if (!result) continue
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
    const result = await one(key, app, source, "backend")
    if (!result) continue
    inputs.set(key, result.inputs)
    built.set(app, result.part)
    backends[id] = { entry: result.entry, pin: result.part.pin, bytes: result.bytes }
  }
  if (missing.size > 0) throw new MissingSharedDeps(missing)
  if (deps) built.set(PREVIEW_SHARED_DEPS_PART, deps.part)
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
    ...(deps
      ? {
          dependencies: {
            entry: `./${previewPartPath(PREVIEW_SHARED_DEPS_PART, deps.pin)}`,
            pin: deps.pin,
            bytes: deps.bytes,
          },
        }
      : {}),
  }
  ;(options.log ?? console.log)(formatPartSizes(manifest, options.budgets))
  if (options.budgets) checkPartBudgets(manifest, options.budgets)
  await mkdir(outdir, { recursive: true })
  await writeFile(
    join(outdir, PREVIEW_LOAD_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  )
  return { manifest, parts: built, inputs, ...(deps ? { deps } : {}), registered }
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
