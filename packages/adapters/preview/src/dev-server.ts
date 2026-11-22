/**
 * The preview's dev loop: `devPreview` builds the same preview `buildPreview` does, keeps it in
 * memory, serves it, and rebuilds when a source file changes. Open tabs hear about each build
 * over the same `/__preview/live` stream a deployed preview uses, so they swap the new version in
 * place, at once: no reload, no countdown, and whatever the page keeps outside the app (the
 * scroll position of other surfaces, an in-tab backend that was not rebuilt) stays.
 *
 * - **Incremental.** One esbuild context: a rebuild reparses only the files that changed.
 * - **Content addressed.** A version is its entry's hash, so a save that changes no output is not
 *   an update, and chunks that did not change keep their URL and stay cached in the browser.
 * - **Never a dead tab.** A failing build keeps the last good version serving and shows the
 *   compiler's message in the page; with no good build yet, the page shows the message and loads
 *   the app as soon as one succeeds.
 *
 * Bun / Node only (esbuild, the file system and `node:http`). esbuild is a peer dependency.
 */
import { type FSWatcher, watch } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, extname, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { gzipSync } from "node:zlib"
import { type BuildContext, build, context, formatMessages, type Message } from "esbuild"
import { type BuildPreviewOptions, planPreviewBuild } from "./build.js"
import { devWaitingPage } from "./dev-boot.js"
import type { PreviewVersion } from "./live.js"
import type { PreviewStatusSnapshot } from "./preview-status.js"

export type DevPreviewOptions = Omit<BuildPreviewOptions, "outdir"> & {
  /** Default 4173. When it is taken the next free one is used, unless `strictPort`. `0`: any. */
  port?: number
  /** Fail when `port` is taken instead of using the next free one. */
  strictPort?: boolean
  /** Default "127.0.0.1". "0.0.0.0" also serves other devices on the network. */
  hostname?: string
  /** Default false: a dev build is readable and a little quicker to make. */
  minify?: boolean
  /** Linked source maps. Default false: on a large app they roughly double the rebuild time. */
  sourcemap?: boolean
  /** How long file changes are gathered before one rebuild. Default 20 ms. */
  debounceMs?: number
  /**
   * How long an open tab counts down before it applies a new version. Default 0: at once. The
   * System screen's Auto-update switch still holds a tab on its version.
   */
  countdownMs?: number
  /**
   * More routes on the same origin, asked before the static files: a dev resources proxy at
   * `/__dev`, an API. Answer `undefined` to pass the request on.
   */
  fetch?(request: Request): Promise<Response | undefined> | Response | undefined
  /** One line per event (listening, each build, each failure). Default `console.log`. */
  log?(line: string): void
}

/** One build of the dev loop. */
export type DevPreviewBuild = {
  ok: boolean
  /** The version built (the entry's hash); on a failure, the last good one, if any. */
  version?: string
  /** How long esbuild took. */
  ms: number
  /** The files whose change started it, relative to the working directory; empty for the first. */
  changed: string[]
  /** The compiler's message, when `ok` is false. */
  error?: string
}

export type DevPreview = {
  /** `http://<hostname>:<port><base>`. */
  url: string
  port: number
  /** What `/version.json` answers now; undefined until a build succeeds. */
  version(): PreviewVersion | undefined
  /** Every build so far, oldest first. */
  builds(): DevPreviewBuild[]
  /** Called after each build, good or bad. */
  subscribe(listener: (build: DevPreviewBuild) => void): () => void
  /** Builds now and resolves with the result (also what a file change does). */
  rebuild(): Promise<DevPreviewBuild>
  /** The server's Fetch handler, for tests and for mounting it in a server of your own. */
  fetch(request: Request): Promise<Response>
  /** Open tabs listening on `/__preview/live`. */
  tabs(): number
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
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
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
}
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|wasm)|image\/svg)/
/** Hashed files never change, so a reload re-reads none of them. */
const IMMUTABLE = "public, max-age=31536000, immutable"
/** Generations of output kept, so a tab one or two builds behind can still load its lazy chunks. */
const KEEP_GENERATIONS = 3
const MAX_MESSAGE = 6_000
const HEARTBEAT_MS = 15_000

type OutFile = { bytes: Uint8Array; type: string; generation: number; gzip?: Uint8Array }

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"

/** Node's `Uint8Array` is a `BodyInit` at run time; the DOM's declaration does not say so. */
const body = (bytes: Uint8Array) => bytes as unknown as BodyInit

const describe = async (error: unknown): Promise<string> => {
  const errors = (error as { errors?: Message[] } | undefined)?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const lines = await formatMessages(errors, { kind: "error", color: false, terminalWidth: 100 })
    return lines.join("\n").trim().slice(0, MAX_MESSAGE)
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE)
}

const send = async (response: Response, incoming: IncomingMessage, outgoing: ServerResponse) => {
  outgoing.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") outgoing.setHeader(key, value)
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) outgoing.setHeader("set-cookie", cookies)
  if (!response.body || incoming.method === "HEAD") {
    await response.body?.cancel()
    outgoing.end()
    return
  }
  outgoing.flushHeaders()
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    outgoing,
  )
}

const listen = (server: ReturnType<typeof createServer>, port: number, hostname: string) =>
  new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(port, hostname, () => {
      server.off("error", fail)
      done()
    })
  })

/**
 * Serves the preview and rebuilds it on every change. Resolves once it is listening and the first
 * build has finished, whether or not that build succeeded.
 */
export async function devPreview(options: DevPreviewOptions): Promise<DevPreview> {
  const plan = planPreviewBuild(options)
  const { workingDir, base } = plan
  const log = options.log ?? ((line: string) => console.log(line))
  const outdir = resolve(workingDir, ".preview-dev")
  const files = new Map<string, OutFile>()
  const history: DevPreviewBuild[] = []
  const listeners = new Set<(build: DevPreviewBuild) => void>()
  const streams = new Set<(snapshot: PreviewStatusSnapshot) => void>()
  /** The streams that are a tab's app (its error card listens on a second one). */
  const tabs = new Set<unknown>()
  const watchers = new Map<string, FSWatcher>()
  let inputs = new Set<string>()
  let current: PreviewVersion | undefined
  let status: PreviewStatusSnapshot["build"]
  let generation = 0
  let closed = false

  const snapshot = (): PreviewStatusSnapshot => ({
    ...(status === undefined ? {} : { build: status }),
    ...(current === undefined
      ? {}
      : { deployed: { version: current.version, at: current.builtAt } }),
    source: "ci",
    updatedAt: new Date().toISOString(),
  })
  const announce = (next: PreviewStatusSnapshot["build"]) => {
    status = next
    const value = snapshot()
    for (const push of streams) push(value)
  }

  const loader = await build({
    ...plan.loader({ dev: true, live: { countdownMs: options.countdownMs ?? 0 } }),
    minify: false,
    write: false,
    outfile: resolve(outdir, "preview.js"),
    logLevel: "silent",
  })
  const bootLoader = loader.outputFiles?.[0]?.contents ?? new Uint8Array()

  const app: BuildContext = await context({
    ...plan.app,
    minify: options.minify ?? false,
    ...(options.sourcemap ? { sourcemap: "linked" as const } : {}),
    outdir,
    write: false,
    logLevel: "silent",
  })

  // ---- Watching: the directories of the files the last good build read.

  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const rewatch = () => {
    // Dependencies do not change while you work; watching them would cost thousands of handles.
    const dirs = new Set(
      [...inputs]
        .filter((file) => !file.includes(`${sep}node_modules${sep}`))
        .map((file) => dirname(file)),
    )
    // With nothing built yet, the entry's own directory is where the fix will be made.
    if (dirs.size === 0) dirs.add(dirname(plan.entryPath))
    for (const [dir, watcher] of watchers)
      if (!dirs.has(dir)) {
        watcher.close()
        watchers.delete(dir)
      }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue
      try {
        const watcher = watch(dir, (_event, name) => {
          if (closed || !name) return
          const file = resolve(dir, name.toString())
          // While the build is broken the fix may be a file it has never read.
          if (!inputs.has(file) && history.at(-1)?.ok !== false) return
          pending.add(file)
          clearTimeout(timer)
          timer = setTimeout(changedOnDisk, options.debounceMs ?? 20)
        })
        watcher.on("error", () => {
          watcher.close()
          watchers.delete(dir)
        })
        watchers.set(dir, watcher)
      } catch {
        // A directory that vanished is watched again after the next build that reads it.
      }
    }
  }

  // ---- Building: one at a time; changes that arrive meanwhile start one more.

  let queue: Promise<unknown> = Promise.resolve()
  let queued = false
  const once = async (): Promise<DevPreviewBuild> => {
    queued = false
    const changed = [...pending].map((file) => relative(workingDir, file)).sort()
    pending = new Set()
    const started = performance.now()
    announce({
      kind: "build",
      state: "building",
      version: "changes",
      at: new Date().toISOString(),
    })
    let result: DevPreviewBuild
    try {
      const built = await app.rebuild()
      const entry = plan.entryOf(built.metafile as NonNullable<typeof built.metafile>, outdir)
      generation++
      for (const file of built.outputFiles ?? []) {
        const path = relative(outdir, file.path).split(sep).join("/")
        // A hashed name is its content: the same path is the same bytes (and gzip) as before.
        const kept = files.get(path)
        if (kept) kept.generation = generation
        else
          files.set(path, {
            bytes: file.contents,
            type: TYPES[extname(path)] ?? "application/octet-stream",
            generation,
          })
      }
      for (const [path, file] of files)
        if (file.generation <= generation - KEEP_GENERATIONS) files.delete(path)
      inputs = new Set(
        Object.keys(built.metafile?.inputs ?? {})
          .filter((input) => !input.includes(":"))
          .map((input) => resolve(workingDir, input)),
      )
      const version = /-([A-Za-z0-9]+)\.js$/.exec(entry)?.[1] ?? `build-${generation}`
      const at = new Date().toISOString()
      if (current?.version !== version) current = { version, builtAt: at, entry }
      result = { ok: true, version, ms: Math.round(performance.now() - started), changed }
      announce({ kind: "build", state: "deployed", version, at })
      const bytes = (built.outputFiles ?? []).reduce((sum, file) => sum + file.contents.length, 0)
      log(
        `${history.length === 0 ? "built" : "rebuilt"} ${version} in ${result.ms} ms · ${(bytes / 1e6).toFixed(1)} MB` +
          (changed.length
            ? ` · ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""}`
            : "") +
          (tabs.size ? ` · ${tabs.size} tab${tabs.size === 1 ? "" : "s"} updated` : ""),
      )
    } catch (error) {
      const message = await describe(error)
      result = {
        ok: false,
        ...(current ? { version: current.version } : {}),
        ms: Math.round(performance.now() - started),
        changed,
        error: message,
      }
      announce({
        kind: "build",
        state: "failed",
        version: "changes",
        at: new Date().toISOString(),
        message,
      })
      log(`build failed in ${result.ms} ms\n${message}`)
    }
    history.push(result)
    rewatch()
    for (const listener of listeners) {
      try {
        listener(result)
      } catch {
        // A listener's failure is its own.
      }
    }
    return result
  }
  const run = (): Promise<DevPreviewBuild> => {
    const next = queue.then(once)
    queue = next.catch(() => {})
    return next
  }
  /** A file changed: one build covers every change gathered before it starts. */
  const changedOnDisk = () => {
    if (queued || closed) return
    queued = true
    void run()
  }

  // ---- Serving.

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": TYPES[".json"] as string, "cache-control": "no-store" },
    })
  const html = (body: string, status = 200) =>
    new Response(body, {
      status,
      headers: { "content-type": TYPES[".html"] as string, "cache-control": "no-store" },
    })

  const live = (request: Request): Response => {
    const counted = !new URL(request.url).searchParams.has("overlay")
    const encoder = new TextEncoder()
    let stop = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            stop()
          }
        }
        const push = (value: PreviewStatusSnapshot) =>
          write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`)
        const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS)
        stop = () => {
          clearInterval(heartbeat)
          streams.delete(push)
          tabs.delete(push)
          request.signal.removeEventListener("abort", stop)
          try {
            controller.close()
          } catch {
            // Already closed or cancelled.
          }
        }
        request.signal.addEventListener("abort", stop)
        streams.add(push)
        if (counted) tabs.add(push)
        write("retry: 500\n\n")
        push(snapshot())
      },
      cancel() {
        stop()
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    })
  }

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const { pathname } = url
    const reading = request.method === "GET" || request.method === "HEAD"
    if (pathname === "/__preview/live" || pathname === "/__preview/status") {
      // The status holds nothing secret, but another site has no business reading your builds.
      if (request.headers.get("sec-fetch-site") === "cross-site")
        return json({ error: "cross-origin request refused" }, 403)
      if (!reading) return json({ error: "method not allowed" }, 405)
      return pathname.endsWith("/live") ? live(request) : json(snapshot())
    }
    const extra = await options.fetch?.(request)
    if (extra) return extra
    if (!reading) return json({ error: "method not allowed" }, 405)
    if (!pathname.startsWith(base)) return html("Not found", 404)
    let path: string
    try {
      path = decodeURIComponent(pathname.slice(base.length))
    } catch {
      return html("Not found", 404)
    }
    if (path === "preview.js")
      return new Response(body(bootLoader), {
        headers: { "content-type": TYPES[".js"] as string, "cache-control": "no-cache" },
      })
    if (path === "version.json")
      return current ? json(current) : json({ error: "no build yet" }, 503)
    if (path === "build.json")
      return current ? json({ entry: current.entry }) : json({ error: "no build yet" }, 503)
    const file = files.get(path)
    if (file) {
      const headers: Record<string, string> = {
        "content-type": file.type,
        "cache-control": IMMUTABLE,
      }
      // Another device pays for every byte; this machine would only pay for the compression.
      if (
        !isLoopback(url.hostname) &&
        file.bytes.length > 1024 &&
        COMPRESSIBLE.test(file.type) &&
        /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
      ) {
        file.gzip ??= gzipSync(file.bytes, { level: 1 })
        return new Response(body(file.gzip), {
          headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" },
        })
      }
      return new Response(body(file.bytes), { headers })
    }
    // A missing file is a 404, never the page: a script that got HTML fails with a riddle.
    if (extname(path) !== "") return html("Not found", 404)
    return html(current ? plan.html : devWaitingPage(history.at(-1)?.error))
  }

  const server = createServer((incoming, outgoing) => {
    const abort = new AbortController()
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort()
    })
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const method = incoming.method ?? "GET"
      const response = await fetchHandler(
        new Request(
          new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`),
          {
            method,
            headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
              value === undefined
                ? []
                : Array.isArray(value)
                  ? value.map((item) => [key, item] as [string, string])
                  : [[key, value] as [string, string]],
            ),
            body: method === "GET" || method === "HEAD" ? null : Buffer.concat(chunks),
            signal: abort.signal,
            redirect: "manual",
          },
        ),
      )
      await send(response, incoming, outgoing)
    })().catch(() => {
      if (outgoing.headersSent) outgoing.destroy()
      else {
        outgoing.writeHead(502)
        outgoing.end("Preview request failed")
      }
    })
  })

  const hostname = options.hostname ?? "127.0.0.1"
  const wanted = options.port ?? 4173
  for (let port = wanted; ; port++) {
    try {
      await listen(server, port, hostname)
      break
    } catch (error) {
      const taken = (error as { code?: string }).code === "EADDRINUSE"
      if (!taken || options.strictPort || wanted === 0 || port >= wanted + 50) {
        await app.dispose()
        throw error
      }
    }
  }
  const { port } = server.address() as AddressInfo
  const shown = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname
  const url = `http://${shown.includes(":") ? `[${shown}]` : shown}:${port}${base}`
  log(`preview dev server: ${url}`)
  await run()

  return {
    url,
    port,
    version: () => current,
    builds: () => history.map((entry) => ({ ...entry, changed: [...entry.changed] })),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    rebuild: run,
    fetch: fetchHandler,
    tabs: () => tabs.size,
    async close() {
      if (closed) return
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      listeners.clear()
      await queue
      await new Promise<void>((done) => {
        server.close(() => done())
        server.closeAllConnections()
      })
      await app.dispose()
    },
  }
}
