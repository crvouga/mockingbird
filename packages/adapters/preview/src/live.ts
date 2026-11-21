/**
 * Live preview client: keeps a preview tab on the latest deployed build without a reload.
 *
 * It listens to the preview's status object over a WebSocket (`${basePath}/live`), falls back to
 * polling `${basePath}/status` while the socket is down, and always polls the static
 * `/version.json`, which names the deployed build's hashed entry. When a newer build is live it
 * disposes the running app and mounts the new one in the same page, never `location.reload()`.
 *
 * The returned object is structurally the UI package's `SystemBuild`; pass it to
 * `mountSystemHarness(host, surfaces, { build })`.
 */

import type { PreviewStatusSnapshot } from "./preview-status.js"

/** `/version.json`: the deployed build. */
export type PreviewVersion = { version: string; builtAt: string; entry: string }

/** Structurally identical to the UI package's `SystemBuildState`. */
export type LiveBuildState = {
  current: { version: string; builtAt: string }
  /** Latest deployed. */
  latest?: { version: string; at: string }
  build?: {
    state: "building" | "deployed" | "failed"
    version: string
    at: string
    url?: string
    message?: string
  }
  checks?: {
    state: "running" | "passed" | "failed"
    version: string
    at: string
    url?: string
    summary?: string
  }
  connection: "live" | "polling" | "offline"
  checkedAt?: string
  update: {
    available: boolean
    applying: boolean
    auto: boolean
    autoApplyAt?: string
    error?: string
  }
  pr?: { number: number; url: string }
}

/** Structurally identical to the UI package's `SystemBuild`. */
export type SystemBuildLike = {
  get(): LiveBuildState
  subscribe(listener: (state: LiveBuildState) => void): () => void
  applyUpdate(): Promise<void>
  postpone(): void
  setAutoUpdate(on: boolean): void
}

export type LivePreview = SystemBuildLike & {
  /** Loads and mounts `current`, then connects. Rejects (still connected) if the mount failed. */
  start(): Promise<void>
  /** Stops listening and polling. The mounted app stays mounted. */
  close(): void
}

type Disposer = () => void | Promise<void>

/** Event targets the client listens on, as much of them as it uses. */
type ListenerTarget = {
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

export type LivePreviewOptions = {
  /** What this tab runs. */
  current: PreviewVersion
  /** Default "/__preview". */
  basePath?: string
  /** Default "/version.json". */
  versionUrl?: string
  /** Loads and mounts a version; returns its disposer. The boot loader supplies this. */
  load(version: PreviewVersion): Promise<Disposer>
  /** Auto-apply delay. Default 10 000 ms. */
  countdownMs?: number
  /** Persists the auto-update preference under `mockingbird.preview.auto-update`. */
  storage?: Pick<Storage, "getItem" | "setItem">
  WebSocket?: typeof WebSocket
  fetch?: typeof fetch
  now?: () => number
  pr?: { number: number; url: string }
  /** Origin the paths resolve against. Default `location.origin`. */
  origin?: string
  /** Listens for `visibilitychange`; read for `hidden`. Default `document`. */
  document?: ListenerTarget & { hidden?: boolean }
  /** Listens for chunk-load failures (`unhandledrejection`, `error`). Default `window`. */
  window?: ListenerTarget
  /** Timer functions. Default the globals. */
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number
}

export const LIVE_PREVIEW_STORAGE_KEY = "mockingbird.preview.auto-update"

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const PING_MS = 25_000
const STATUS_POLL_MS = 15_000
const VERSION_POLL_MS = 60_000
const PENDING_RECHECK_MS = 5_000
const OPEN = 1

const CHUNK_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed/i

/** `true` when an `error` / `unhandledrejection` event is a lazy chunk that failed to load. */
export function isChunkLoadFailure(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false
  const record = event as { reason?: unknown; error?: unknown; message?: unknown }
  for (const candidate of [record.reason, record.error, record]) {
    if (typeof candidate === "string" && CHUNK_FAILURE.test(candidate)) return true
    if (typeof candidate !== "object" || candidate === null) continue
    const { name, message } = candidate as { name?: unknown; message?: unknown }
    if (name === "ChunkLoadError") return true
    if (typeof message === "string" && CHUNK_FAILURE.test(message)) return true
  }
  return false
}

const isVersion = (value: unknown): value is PreviewVersion => {
  if (typeof value !== "object" || value === null) return false
  const { version, builtAt, entry } = value as Record<string, unknown>
  return typeof version === "string" && typeof builtAt === "string" && typeof entry === "string"
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

/** `value` without trailing slashes, in linear time. */
const withoutTrailingSlashes = (value: string): string => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Keeps a preview tab on the latest deployed build, live, without reloading the page. */
export function createLivePreview(options: LivePreviewOptions): LivePreview {
  const basePath = withoutTrailingSlashes(options.basePath ?? "/__preview")
  const versionPath = options.versionUrl ?? "/version.json"
  const countdownMs = options.countdownMs ?? 10_000
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  // Captured now: the app versions this loads may install their own runtime and replace the
  // globals (the browser runtime routes fetch to in-page servers), but status and version checks
  // must always reach the real network.
  const nativeFetch = globalThis.fetch
  const doFetch =
    options.fetch ??
    ((input: string, init?: RequestInit) => nativeFetch.call(globalThis, input, init))
  const Socket = options.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const doc =
    options.document ??
    (globalThis as { document?: ListenerTarget & { hidden?: boolean } }).document
  const win = options.window ?? (globalThis as { window?: ListenerTarget }).window
  const origin =
    options.origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? ""
  const url = (path: string) => (origin ? new URL(path, origin).href : path)

  const readAuto = (): boolean => {
    try {
      return options.storage?.getItem(LIVE_PREVIEW_STORAGE_KEY) !== "off"
    } catch {
      return true
    }
  }

  let current = options.current
  let disposer: Disposer | undefined
  let snapshot: PreviewStatusSnapshot | undefined
  let deployed: PreviewVersion | undefined // from /version.json
  let socket: WebSocket | undefined
  let socketOpen = false
  let statusOk = false
  let versionOk = false
  let checkedAt: string | undefined
  let auto = readAuto()
  let applying = false
  let error: string | undefined
  let autoApplyAt: number | undefined
  let postponed: string | undefined
  let failed: string | undefined
  let countdownFor: string | undefined
  let attempts = 0
  let closed = true
  const handles = new Map<string, unknown>()
  const listeners = new Set<(state: LiveBuildState) => void>()

  const later = (name: string, ms: number, run: () => void) => {
    clear(name)
    handles.set(
      name,
      timers.setTimeout(() => {
        handles.delete(name)
        run()
      }, ms),
    )
  }
  const clear = (name: string) => {
    if (handles.has(name)) timers.clearTimeout(handles.get(name))
    handles.delete(name)
  }

  /** The version this tab should run next, once its assets are live; undefined when none. */
  const target = (): PreviewVersion | undefined => {
    if (deployed === undefined || deployed.version === current.version) return undefined
    const announced = snapshot?.deployed
    if (
      announced !== undefined &&
      announced.version !== deployed.version &&
      Date.parse(announced.at) > Date.parse(deployed.builtAt)
    ) {
      // A newer deploy was announced but /version.json does not name it yet.
      return undefined
    }
    return deployed
  }

  const buildState = (): LiveBuildState => {
    const next = target()
    const latest = snapshot?.deployed
      ? { version: snapshot.deployed.version, at: snapshot.deployed.at }
      : deployed
        ? { version: deployed.version, at: deployed.builtAt }
        : undefined
    const build = snapshot?.build
    const checks = snapshot?.checks
    const source = options.pr ?? snapshot?.pr
    const pr = source ? { number: source.number, url: source.url } : undefined
    return {
      current: { version: current.version, builtAt: current.builtAt },
      ...(latest ? { latest } : {}),
      ...(build
        ? {
            build: {
              state: build.state,
              version: build.version,
              at: build.at,
              ...(build.runUrl === undefined ? {} : { url: build.runUrl }),
              ...(build.message === undefined ? {} : { message: build.message }),
            },
          }
        : {}),
      ...(checks
        ? {
            checks: {
              state: checks.state,
              version: checks.version,
              at: checks.at,
              ...(checks.runUrl === undefined ? {} : { url: checks.runUrl }),
              ...(checks.summary === undefined ? {} : { summary: checks.summary }),
            },
          }
        : {}),
      connection: socketOpen ? "live" : statusOk || versionOk ? "polling" : "offline",
      ...(checkedAt === undefined ? {} : { checkedAt }),
      update: {
        available: next !== undefined,
        applying,
        auto,
        ...(autoApplyAt === undefined ? {} : { autoApplyAt: new Date(autoApplyAt).toISOString() }),
        ...(error === undefined ? {} : { error }),
      },
      ...(pr ? { pr } : {}),
    }
  }

  let state = deepFreeze(buildState())
  const emit = () => {
    state = deepFreeze(buildState())
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  const contact = () => {
    checkedAt = new Date(now()).toISOString()
  }

  /** Starts, keeps or cancels the auto-apply countdown for the current target. */
  const schedule = () => {
    const next = target()
    const wanted =
      next !== undefined &&
      auto &&
      !applying &&
      postponed !== next.version &&
      failed !== next.version
    if (!wanted) {
      clear("countdown")
      autoApplyAt = undefined
      countdownFor = undefined
      return
    }
    if (disposer === undefined || doc?.hidden === true) {
      // Nothing running to interrupt, or nobody watching: apply now.
      clear("countdown")
      autoApplyAt = undefined
      countdownFor = undefined
      void applyUpdate()
      return
    }
    if (countdownFor === next.version && autoApplyAt !== undefined) return
    countdownFor = next.version
    autoApplyAt = now() + countdownMs
    later("countdown", countdownMs, () => {
      autoApplyAt = undefined
      countdownFor = undefined
      void applyUpdate()
    })
  }

  const changed = () => {
    if (closed) return
    schedule()
    emit()
  }

  const checkVersion = async (): Promise<void> => {
    try {
      const response = await doFetch(url(versionPath), { cache: "no-store" })
      if (!response.ok) throw new Error(`version ${response.status}`)
      const body: unknown = await response.json()
      if (!isVersion(body)) throw new Error("malformed version.json")
      deployed = body
      versionOk = true
      contact()
    } catch {
      versionOk = false
    }
    const announced = snapshot?.deployed?.version
    if (
      announced !== undefined &&
      announced !== current.version &&
      announced !== deployed?.version
    ) {
      // Announced but its assets are not live yet: look again soon.
      later("pending", PENDING_RECHECK_MS, () => void checkVersion())
    }
    changed()
  }

  const pollVersion = () => {
    later("version", VERSION_POLL_MS, () => {
      void checkVersion()
      pollVersion()
    })
  }

  const acceptSnapshot = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    const previous = snapshot?.deployed?.version
    snapshot = value as PreviewStatusSnapshot
    contact()
    const announced = snapshot.deployed?.version
    if (announced !== undefined && announced !== previous && announced !== deployed?.version) {
      void checkVersion()
    }
    changed()
  }

  const checkStatus = async (): Promise<void> => {
    try {
      const response = await doFetch(url(`${basePath}/status`), { cache: "no-store" })
      if (!response.ok) throw new Error(`status ${response.status}`)
      statusOk = true
      acceptSnapshot(await response.json())
    } catch {
      statusOk = false
      changed()
    }
  }

  const pollStatus = () => {
    if (socketOpen || closed) return
    later("status", STATUS_POLL_MS, () => {
      void checkStatus()
      pollStatus()
    })
  }

  const ping = () => {
    later("ping", PING_MS, () => {
      if (socket?.readyState === OPEN) {
        try {
          socket.send("ping")
        } catch {
          // The close handler reconnects.
        }
      }
      ping()
    })
  }

  const connect = () => {
    if (closed || Socket === undefined) return
    clear("reconnect")
    const wsUrl = new URL(`${basePath}/live`, origin || "http://localhost")
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
    let ws: WebSocket
    try {
      ws = new Socket(wsUrl.href)
    } catch {
      disconnected()
      return
    }
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      attempts = 0
      socketOpen = true
      contact()
      clear("status")
      ping()
      changed()
    }
    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== "string") return
      if (event.data === "pong") {
        contact()
        changed()
        return
      }
      try {
        const message = JSON.parse(event.data) as { type?: unknown; snapshot?: unknown }
        if (message.type === "snapshot") acceptSnapshot(message.snapshot)
      } catch {
        // Not ours.
      }
    }
    ws.onclose = () => {
      if (socket === ws) disconnected()
    }
    ws.onerror = () => {
      // onclose follows.
    }
  }

  const disconnected = () => {
    socket = undefined
    const wasOpen = socketOpen
    socketOpen = false
    clear("ping")
    if (closed) return
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempts)
    attempts++
    later("reconnect", ceiling / 2 + (random() * ceiling) / 2, connect)
    if (!handles.has("status")) {
      void checkStatus()
      pollStatus()
    }
    if (wasOpen) changed()
  }

  const onVisibility = () => {
    if (doc?.hidden === true) {
      // Nobody is watching: a pending countdown can apply now.
      if (autoApplyAt !== undefined) {
        clear("countdown")
        autoApplyAt = undefined
        countdownFor = undefined
        void applyUpdate()
      }
      return
    }
    void checkVersion()
    if (!socketOpen) {
      void checkStatus()
      attempts = 0
      connect()
    }
  }

  const onFailure = (event: unknown) => {
    if (!isChunkLoadFailure(event)) return
    // The running bundle's chunks are gone: a newer build replaced them. Move to it now.
    void (async () => {
      await checkVersion()
      if (target() !== undefined) await applyUpdate()
    })()
  }

  const applyUpdate = async (): Promise<void> => {
    const next = target()
    if (next === undefined || applying) return
    clear("countdown")
    autoApplyAt = undefined
    countdownFor = undefined
    applying = true
    error = undefined
    emit()
    const previous = current
    try {
      const dispose = disposer
      disposer = undefined
      await dispose?.()
    } catch {
      // A failing disposer must not keep the tab on the old build.
    }
    try {
      disposer = await options.load(next)
      current = next
      failed = undefined
      postponed = undefined
    } catch (loadError) {
      failed = next.version
      error = `Could not load ${next.version.slice(0, 7)}: ${errorText(loadError)}`
      try {
        disposer = await options.load(previous)
      } catch (restoreError) {
        error += `; restoring ${previous.version.slice(0, 7)} also failed: ${errorText(restoreError)}`
      }
    }
    applying = false
    if (closed) {
      emit()
      return
    }
    changed()
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    applyUpdate,
    postpone() {
      const next = target()
      if (next !== undefined) postponed = next.version
      clear("countdown")
      autoApplyAt = undefined
      countdownFor = undefined
      emit()
    },
    setAutoUpdate(on) {
      auto = on
      try {
        options.storage?.setItem(LIVE_PREVIEW_STORAGE_KEY, on ? "on" : "off")
      } catch {
        // Not persisted; still applies to this tab.
      }
      if (closed) emit()
      else changed()
    },
    async start() {
      if (!closed) return
      closed = false
      let mountError: unknown
      try {
        disposer = await options.load(current)
      } catch (cause) {
        mountError = cause
        error = `Could not load ${current.version.slice(0, 7)}: ${errorText(cause)}`
      }
      doc?.addEventListener("visibilitychange", onVisibility)
      win?.addEventListener("unhandledrejection", onFailure)
      win?.addEventListener("error", onFailure)
      connect()
      if (Socket === undefined) {
        void checkStatus()
        pollStatus()
      }
      await checkVersion()
      pollVersion()
      if (mountError !== undefined) throw mountError
    },
    close() {
      if (closed) return
      closed = true
      for (const name of [...handles.keys()]) clear(name)
      doc?.removeEventListener("visibilitychange", onVisibility)
      win?.removeEventListener("unhandledrejection", onFailure)
      win?.removeEventListener("error", onFailure)
      const ws = socket
      socket = undefined
      socketOpen = false
      try {
        ws?.close(1000, "closed")
      } catch {
        // Already closed.
      }
      emit()
    },
  }
}
