/**
 * The local dev loop for a built preview: serves the preview directory, watches the consumer's
 * sources, runs the consumer's build on every change, stamps a new `version.json`, and pushes the
 * new build to every open tab over the same `/__preview/live` stream `createLivePreview` reads. The
 * snapshots it sends say `dev: true`, so the tab applies each build at once (no countdown, no
 * prompt) whenever it keeps the tab's data (`stateVersion` unchanged).
 *
 *   mockingbird-preview dev --outdir preview-dist --build "bun run build:preview" --watch src
 *
 * Bun / Node only (the file system, `node:http` and child processes).
 */
import { spawn } from "node:child_process"
import { type FSWatcher, watch } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, relative, resolve, sep } from "node:path"
import type { PreviewVersion } from "./live.js"
import type { PreviewStatusSnapshot } from "./preview-status.js"

/**
 * The consumer's build: a function, a shell command line, or an argv (run without a shell). It
 * writes the built preview (with `version.json` or `build.json` naming the entry) into `outdir`.
 */
export type PreviewDevBuild =
  | string
  | readonly string[]
  | ((context: { changed: readonly string[]; signal: AbortSignal }) => unknown)

export type PreviewDevServerOptions = {
  /** The built preview directory the server serves (what `buildPreview` writes). */
  outdir: string
  build: PreviewDevBuild
  /** Files or directories (watched recursively) whose changes trigger a build. */
  watch: readonly string[]
  /** Paths never trigger a build: default `node_modules`, `.git` and `outdir` itself. */
  ignore?: (path: string) => boolean
  /** Default 0 (any free port). */
  port?: number
  /** Default "127.0.0.1". */
  hostname?: string
  /** Where the status and live stream are served. Default "/__preview". */
  basePath?: string
  /** Quiet time after the last change before building. Default 100 ms. */
  debounceMs?: number
  /**
   * The data shape the build keeps in the tab. Default: whatever the built `version.json` names.
   * When it changes, open tabs offer the update (it resets their data) instead of applying it.
   */
  stateVersion?: string | (() => string | undefined | Promise<string | undefined>)
  /** Where relative paths and the build command run. Default `process.cwd()`. */
  cwd?: string
  /** Extra routes (the dev proxy, part updates, …); `undefined` falls through to the files. */
  handle?: (request: Request) => Response | Promise<Response> | undefined
  /** Progress lines. Default `console.log`. */
  log?: (line: string) => void
  /** Run the first build before serving. Default true; false serves what `outdir` holds. */
  initialBuild?: boolean
}

/** One build the dev server ran. */
export type PreviewDevBuildResult = {
  /** The version it stamped (`dev-<session>-<n>`); on failure the version it would have been. */
  version: string
  ok: boolean
  /** The files whose change started it (empty for the first build or `rebuild()`). */
  changed: string[]
  ms: number
  error?: string
}

export type PreviewDevServer = {
  /** `http://<hostname>:<port>`, once listening. */
  readonly url: string
  /** Resolves after the first build (or at once when `initialBuild` is false). */
  ready: Promise<void>
  /** Builds now (queued behind a running build) and resolves with its result. */
  rebuild(changed?: readonly string[]): Promise<PreviewDevBuildResult>
  /** The version served now. */
  version(): PreviewVersion | undefined
  builds(): PreviewDevBuildResult[]
  /** The status snapshot the live stream sends now. */
  snapshot(): PreviewStatusSnapshot
  /** The same routes the HTTP server serves, as a Fetch handler. */
  fetch(request: Request): Promise<Response>
  /** Number of open `/live` streams. */
  connections(): number
  close(): Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

const HEARTBEAT_MS = 15_000

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Runs a command line (through the shell) or an argv; rejects with its output's tail. */
const runCommand = (command: string | readonly string[], cwd: string, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const [file, ...rest] = typeof command === "string" ? [command] : command
    if (file === undefined || file === "") {
      fail(new Error("The build command is empty"))
      return
    }
    const child = spawn(file, rest, {
      cwd,
      shell: typeof command === "string",
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    })
    let output = ""
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4_000)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", (error) => fail(error))
    child.on("close", (code) => {
      if (code === 0) done()
      else {
        const tail = output.trim().split("\n").slice(-5).join("\n")
        fail(new Error(`The build exited ${code ?? "on a signal"}${tail ? `: ${tail}` : ""}`))
      }
    })
  })

/**
 * Serves a built preview locally and keeps every open tab on the newest build: a change under
 * `watch` runs `build`, stamps `version.json` with a new dev version and pushes it over
 * `/__preview/live`. See the module comment.
 */
export async function createPreviewDevServer(
  options: PreviewDevServerOptions,
): Promise<PreviewDevServer> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const outdir = resolve(cwd, options.outdir)
  let basePath = options.basePath ?? "/__preview"
  while (basePath.endsWith("/")) basePath = basePath.slice(0, -1)
  const log = options.log ?? ((line: string) => console.log(line))
  const debounceMs = options.debounceMs ?? 100
  const session = Math.random().toString(36).slice(2, 8)
  const ignored =
    options.ignore ??
    ((path: string) =>
      path === outdir ||
      path.startsWith(`${outdir}${sep}`) ||
      path.split(sep).some((part) => part === "node_modules" || part === ".git"))

  let sequence = 0
  let current: PreviewVersion | undefined
  let building: { version: string; at: string } | undefined
  let lastFailure: { version: string; at: string; message: string } | undefined
  const history: PreviewDevBuildResult[] = []
  const streams = new Set<(snapshot: PreviewStatusSnapshot) => void>()
  const closers = new Set<() => void>()
  let closed = false
  const lifetime = new AbortController()

  const snapshot = (): PreviewStatusSnapshot => {
    const at = new Date().toISOString()
    const build = building
      ? { kind: "build" as const, state: "building" as const, ...building }
      : lastFailure
        ? {
            kind: "build" as const,
            state: "failed" as const,
            version: lastFailure.version,
            at: lastFailure.at,
            message: lastFailure.message.slice(0, 500),
          }
        : current
          ? {
              kind: "build" as const,
              state: "deployed" as const,
              version: current.version,
              at: current.builtAt,
            }
          : undefined
    return {
      ...(build ? { build } : {}),
      ...(current ? { deployed: { version: current.version, at: current.builtAt } } : {}),
      source: "none",
      message: "Local dev server",
      dev: true,
      updatedAt: at,
    }
  }
  const publish = () => {
    const value = snapshot()
    for (const send of streams) send(value)
  }

  const stateVersion = async (built: Record<string, unknown> | undefined) => {
    const option = options.stateVersion
    if (typeof option === "function") return await option()
    if (option !== undefined) return option
    return typeof built?.stateVersion === "string" ? built.stateVersion : undefined
  }

  /** Reads what the build wrote and stamps `version.json` with the next dev version. */
  const stamp = async (version: string): Promise<PreviewVersion> => {
    const built = await readJson(join(outdir, "version.json"))
    const manifest = await readJson(join(outdir, "build.json"))
    const entry =
      typeof manifest?.entry === "string"
        ? manifest.entry
        : typeof built?.entry === "string"
          ? built.entry
          : undefined
    if (entry === undefined)
      throw new Error(`${outdir} has no build.json or version.json naming the entry`)
    const state = await stateVersion(built)
    const next: PreviewVersion = {
      version,
      builtAt: new Date().toISOString(),
      entry,
      ...(state === undefined || state === "" ? {} : { stateVersion: state }),
    }
    await writeFile(join(outdir, "version.json"), `${JSON.stringify(next)}\n`, "utf8")
    return next
  }

  let queue: Promise<unknown> = Promise.resolve()
  const runBuild = (changed: readonly string[]): Promise<PreviewDevBuildResult> => {
    const result = queue.then(async (): Promise<PreviewDevBuildResult> => {
      const version = `dev-${session}-${++sequence}`
      const started = Date.now()
      building = { version, at: new Date(started).toISOString() }
      publish()
      let outcome: PreviewDevBuildResult
      try {
        const build = options.build
        if (typeof build === "function") await build({ changed, signal: lifetime.signal })
        else await runCommand(build, cwd, lifetime.signal)
        current = await stamp(version)
        lastFailure = undefined
        outcome = { version, ok: true, changed: [...changed], ms: Date.now() - started }
        log(`mockingbird-preview dev: built ${version} in ${outcome.ms} ms`)
      } catch (error) {
        lastFailure = { version, at: new Date().toISOString(), message: describe(error) }
        outcome = {
          version,
          ok: false,
          changed: [...changed],
          ms: Date.now() - started,
          error: describe(error),
        }
        log(`mockingbird-preview dev: build ${version} failed: ${describe(error)}`)
      }
      building = undefined
      history.push(outcome)
      if (!closed) publish()
      return outcome
    })
    queue = result.catch(() => {})
    return result
  }

  // Changes while a build runs collect into the next one.
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onChange = (path: string) => {
    if (closed || ignored(path)) return
    pending.add(path)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const changed = [...pending].sort()
      pending = new Set()
      void runBuild(changed.map((file) => relative(cwd, file)))
    }, debounceMs)
  }
  const watchers: FSWatcher[] = []
  for (const target of options.watch) {
    const path = resolve(cwd, target)
    let directory = false
    try {
      directory = (await stat(path)).isDirectory()
    } catch {
      throw new Error(`Cannot watch ${path}: it does not exist`)
    }
    watchers.push(
      watch(path, { recursive: directory }, (_event, name) => {
        onChange(directory && name ? resolve(path, name.toString()) : path)
      }),
    )
  }

  const readVersion = async (): Promise<PreviewVersion | undefined> => {
    const value = await readJson(join(outdir, "version.json"))
    if (
      typeof value?.version === "string" &&
      typeof value.builtAt === "string" &&
      typeof value.entry === "string"
    )
      return value as PreviewVersion
    return undefined
  }

  const live = (request: Request): Response => {
    const encoder = new TextEncoder()
    let stop = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            stop()
          }
        }
        const send = (value: PreviewStatusSnapshot) =>
          write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`)
        const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS)
        stop = () => {
          clearInterval(heartbeat)
          streams.delete(send)
          closers.delete(stop)
          request.signal.removeEventListener("abort", stop)
          try {
            controller.close()
          } catch {
            /* Already closed. */
          }
        }
        streams.add(send)
        closers.add(stop)
        request.signal.addEventListener("abort", stop)
        write("retry: 1000\n\n")
        send(snapshot())
      },
      cancel() {
        stop()
      },
    })
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    })
  }

  const file = async (request: Request, pathname: string): Promise<Response> => {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return new Response("Bad path", { status: 400 })
    }
    let path = resolve(outdir, `.${decoded}`)
    if (path !== outdir && !path.startsWith(`${outdir}${sep}`))
      return new Response("Not found", { status: 404 })
    let info = await stat(path).catch(() => undefined)
    if (info?.isDirectory()) {
      path = join(path, "index.html")
      info = await stat(path).catch(() => undefined)
    }
    if (!info?.isFile()) {
      // The single-page-application fallback: a deep link without an extension gets index.html.
      if (extname(decoded) !== "") return new Response("Not found", { status: 404 })
      path = join(outdir, "index.html")
      info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) return new Response("Not found", { status: 404 })
    }
    // Revalidated on every load, so a rebuilt file is never stale, while an unchanged one
    // answers 304 and keeps the browser's caches (including its compiled-code cache).
    const etag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`
    const headers = {
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": path.endsWith(`${sep}version.json`) ? "no-store" : "no-cache",
      etag,
    }
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers })
    const bytes = await readFile(path)
    return new Response(request.method === "HEAD" ? null : bytes, { headers })
  }

  const fetch = async (request: Request): Promise<Response> => {
    const extra = options.handle?.(request)
    if (extra !== undefined) return extra
    const { pathname } = new URL(request.url)
    if (pathname === `${basePath}/live` || pathname === `${basePath}/status`) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return Response.json({ error: "method not allowed" }, { status: 405 })
      if (pathname.endsWith("/live")) return live(request)
      return Response.json(snapshot(), { headers: { "cache-control": "no-store" } })
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 })
    return file(request, pathname)
  }

  const handler = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const abort = new AbortController()
    outgoing.on("close", () => abort.abort())
    void (async () => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(key, value)
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      }
      const response = await fetch(
        new Request(new URL(incoming.url ?? "/", "http://localhost"), {
          method: incoming.method ?? "GET",
          headers,
          signal: abort.signal,
        }),
      )
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) {
        outgoing.end()
        return
      }
      outgoing.flushHeaders()
      const reader = response.body.getReader()
      abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}))
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        outgoing.write(value)
      }
      outgoing.end()
    })().catch((error) => {
      if (outgoing.headersSent) outgoing.destroy()
      else {
        outgoing.writeHead(500)
        outgoing.end(describe(error))
      }
    })
  }

  const server = createServer(handler)
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
      server.off("error", fail)
      done()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The dev server has no address")
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address
  const url = `http://${host}:${address.port}`

  const ready =
    options.initialBuild === false
      ? readVersion().then((version) => {
          current = version
        })
      : runBuild([]).then(() => {})

  return {
    url,
    ready,
    rebuild: (changed = []) => runBuild(changed),
    version: () => current,
    builds: () => history.map((entry) => ({ ...entry, changed: [...entry.changed] })),
    snapshot,
    fetch,
    connections: () => streams.size,
    async close() {
      if (closed) return
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      for (const stop of [...closers]) stop()
      lifetime.abort()
      await queue
      await new Promise<void>((done) => {
        server.close(() => done())
        server.closeAllConnections()
      })
    },
  }
}
