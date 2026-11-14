import { createFsFromVolume, Volume } from "memfs"

export type WebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type FetchHandler = (request: Request) => Response | Promise<Response>
export class UnsupportedRuntimeError extends Error {
  readonly code = "ERR_BROWSER_RUNTIME_UNSUPPORTED"
  constructor(api: string) {
    super(
      `${api} is not implemented by the browser runtime. Use a browser-compatible dependency or an explicit system adapter.`,
    )
    this.name = "UnsupportedRuntimeError"
  }
}
const unsupported = (api: string): never => {
  throw new UnsupportedRuntimeError(api)
}

/** Unknown runtime APIs fail on access rather than pretending an OS capability exists. */
function strict<T extends object>(name: string, value: T): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target) return Reflect.get(target, key, receiver)
      return unsupported(`${name}.${key}`)
    },
  })
}

/** Each instance owns a separate filesystem, environment and virtual listener table. */
export function createBrowserRuntime(
  options: { env?: Record<string, string>; networkFetch?: WebFetch } = {},
) {
  const volume = new Volume()
  const fs = createFsFromVolume(volume)
  const env = { ...options.env }
  const listeners = new Map<string, FetchHandler>()
  let nextPort = 3000
  let disposed = false
  const assertOpen = () => {
    if (disposed) throw new Error("Browser runtime has been disposed")
  }
  const serve = (options: { port?: number; hostname?: string; fetch: FetchHandler }) => {
    assertOpen()
    for (const key of Object.keys(options)) {
      if (!["port", "hostname", "fetch"].includes(key)) unsupported(`serve option ${key}`)
    }
    const hostname = options.hostname ?? "localhost"
    if (!["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(hostname))
      unsupported("serve hostname")
    let port = options.port ?? 3000
    if (port === 0) {
      while (listeners.has(`http://localhost:${nextPort}`)) nextPort++
      port = nextPort++
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new RangeError("Invalid server port")
    const url = new URL(`http://localhost:${port}`)
    if (listeners.has(url.origin))
      throw Object.assign(new Error(`Address in use: ${url.origin}`), { code: "EADDRINUSE" })
    listeners.set(url.origin, options.fetch)
    let stopped = false
    let finish: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const stop = () => {
      if (stopped) return
      stopped = true
      listeners.delete(url.origin)
      finish?.()
    }
    stops.add(stop)
    return { url, port, hostname, stop, shutdown: async () => stop(), finished }
  }
  const stops = new Set<() => void>()
  const runtimeFetch: WebFetch = async (input, init) => {
    assertOpen()
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const url = new URL(request.url)
    if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) {
      url.hostname = "localhost"
      const handler = listeners.get(url.origin)
      if (!handler) throw new TypeError(`fetch failed: no browser-local server at ${url.origin}`)
      // Race cancellation without transferring requests to a real localhost service.
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(request.signal.reason)
        request.signal.addEventListener("abort", abort, { once: true })
        Promise.resolve()
          .then(() => handler(request))
          .then(resolve, reject)
          .finally(() => request.signal.removeEventListener("abort", abort))
      })
    }
    if (!options.networkFetch)
      throw new TypeError(`External network access disabled: ${url.origin}`)
    return options.networkFetch(request)
  }
  const path = (value: string | URL) => {
    if (!(value instanceof URL)) return value
    if (value.protocol !== "file:" || value.hostname)
      throw new TypeError("Expected a local file URL")
    return decodeURIComponent(value.pathname)
  }
  const file = (value: string | URL) => {
    const name = path(value)
    const bytes = () => new Uint8Array(fs.readFileSync(name) as Uint8Array)
    return {
      get size() {
        return fs.statSync(name).size
      },
      type: "",
      name,
      exists: async () => fs.existsSync(name),
      text: async () => new TextDecoder().decode(bytes()),
      json: async () => JSON.parse(new TextDecoder().decode(bytes())) as unknown,
      arrayBuffer: async () => bytes().buffer,
      stream: () => new Blob([bytes()]).stream(),
      slice: (start?: number, end?: number, type?: string) =>
        new Blob([bytes()]).slice(start, end, type),
    }
  }
  const write = async (
    target: string | URL,
    data: string | Uint8Array | ArrayBuffer | Blob | Response,
  ) => {
    assertOpen()
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer())
    await fs.promises.writeFile(path(target), bytes)
    return bytes.byteLength
  }
  const bun = strict("Bun", {
    env,
    file,
    write,
    serve,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  })
  const fileInfo = (name: string | URL) => {
    const stat = fs.statSync(path(name))
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymlink: stat.isSymbolicLink(),
      size: stat.size,
      mtime: stat.mtime,
      atime: stat.atime,
      birthtime: stat.birthtime,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
    }
  }
  const deno = strict("Deno", {
    env: {
      get: (key: string) => env[key],
      set: (key: string, value: string) => {
        env[key] = value
      },
      has: (key: string) => key in env,
      delete: (key: string) => {
        delete env[key]
      },
      toObject: () => ({ ...env }),
    },
    readFile: async (name: string | URL) =>
      new Uint8Array((await fs.promises.readFile(path(name))) as Uint8Array),
    readTextFile: async (name: string | URL) =>
      String(await fs.promises.readFile(path(name), "utf8")),
    writeFile: async (name: string | URL, data: Uint8Array) => {
      await write(name, data)
    },
    writeTextFile: async (name: string | URL, data: string) => {
      await write(name, data)
    },
    mkdir: async (name: string | URL, opts?: { recursive?: boolean }) => {
      await fs.promises.mkdir(path(name), opts)
    },
    remove: async (name: string | URL, opts?: { recursive?: boolean }) => {
      await fs.promises.rm(path(name), opts)
    },
    rename: async (old: string | URL, next: string | URL) =>
      fs.promises.rename(path(old), path(next)),
    readFileSync: (name: string | URL) => new Uint8Array(fs.readFileSync(path(name)) as Uint8Array),
    readTextFileSync: (name: string | URL) => String(fs.readFileSync(path(name), "utf8")),
    writeFileSync: (name: string | URL, data: Uint8Array) => {
      fs.writeFileSync(path(name), data)
    },
    writeTextFileSync: (name: string | URL, data: string) => {
      fs.writeFileSync(path(name), data)
    },
    mkdirSync: (name: string | URL, opts?: { recursive?: boolean }) => {
      fs.mkdirSync(path(name), opts)
    },
    removeSync: (name: string | URL, opts?: { recursive?: boolean }) => {
      fs.rmSync(path(name), opts)
    },
    renameSync: (old: string | URL, next: string | URL) => fs.renameSync(path(old), path(next)),
    stat: async (name: string | URL) => fileInfo(name),
    statSync: fileInfo,
    realPath: async (name: string | URL) => String(fs.realpathSync(path(name))),
    realPathSync: (name: string | URL) => String(fs.realpathSync(path(name))),
    async *readDir(name: string | URL) {
      for (const entry of fs.readdirSync(path(name), { withFileTypes: true })) {
        if (!(entry instanceof fs.Dirent)) throw new TypeError("Expected directory entry")
        yield {
          name: String(entry.name),
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink(),
        }
      }
    },
    cwd: () => "/",
    serve: (
      handlerOrOptions: FetchHandler | { port?: number; hostname?: string },
      handler?: FetchHandler,
    ) => {
      const fetch = typeof handlerOrOptions === "function" ? handlerOrOptions : handler
      if (!fetch) throw new TypeError("Deno.serve requires a handler")
      return serve({ ...(typeof handlerOrOptions === "function" ? {} : handlerOrOptions), fetch })
    },
  })
  return {
    fs,
    volume,
    env,
    bun,
    deno,
    fetch: runtimeFetch,
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      stops.clear()
      volume.reset()
      for (const key of Object.keys(env)) delete env[key]
    },
  }
}

/** The bundler's fs, process, Bun and Deno imports share this one world per JS realm. */
export const browserRuntime = createBrowserRuntime({
  networkFetch: globalThis.fetch?.bind(globalThis),
})
