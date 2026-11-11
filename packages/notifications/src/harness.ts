import {
  asServiceKind,
  discoverFleet,
  type Endpoint,
  endpointsFromManifest,
  endpointsFromServices,
  type FetchLike,
  type FleetManifest,
  type ServiceInput,
} from "./discovery.js"
import { BROWSER_JS } from "./generated/browser.js"
import {
  filterFromSearch,
  matches,
  type Notification,
  type NotificationFilter,
  SERVICE_KINDS,
  type SourceStatus,
} from "./model.js"
import { READERS } from "./sources.js"
import { renderPage } from "./ui/page.js"

export type HarnessOptions = {
  /** A running fleet controller's `adminBase` (`http://127.0.0.1:9000/__admin/fleet`). */
  fleet?: string
  /** A fleet ready manifest, or a function that reads the current one (re-read on every sync). */
  manifest?: FleetManifest | (() => FleetManifest | Promise<FleetManifest>)
  /** Explicit emulators by name: base URLs, `{ url, adminUrl }`, or in-process runtimes. */
  services?: Record<string, ServiceInput>
  /**
   * Namespaces to watch in the background. `"all"` follows the fleet's namespace list.
   * Any namespace an API call or the UI asks for is watched from then on. Default `["default"]`,
   * or `"all"` with `fleet`.
   */
  namespaces?: "all" | string[]
  /** Background polling interval. `0` turns it off; reads still sync on demand. Default 750 ms. */
  pollIntervalMs?: number
  /** Sent as `x-mockingbird-admin-key` to the fleet and every emulator. */
  adminKey?: string
  /** Transport for URL endpoints. Default: global `fetch`. */
  fetch?: FetchLike
  /** Page title. */
  title?: string
}

export type WaitOptions = { timeoutMs?: number; count?: number }

export type NotificationHarness = {
  /** The harness UI and JSON API as a Fetch handler. */
  fetch(request: Request): Promise<Response>
  /** Read every emulator now. Resolves after a read that started after this call. */
  sync(namespace?: string): Promise<void>
  /** Notifications matching `filter`, oldest first, after a fresh sync. */
  list(filter?: NotificationFilter): Promise<Notification[]>
  /** Resolve once at least `count` (default 1) notifications match; reject after `timeoutMs`. */
  waitFor(filter: NotificationFilter, options?: WaitOptions): Promise<Notification[]>
  sources(): SourceStatus[]
  close(): void
}

type Bucket = {
  notifications: Map<string, Notification>
  inFlight: Promise<void> | null
  queued: Promise<void> | null
  version: number
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })

const errorBody = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_notifications", message } })

const REDISCOVER_MS = 2_000
const DUPLICATE_WINDOW_MS = 10_000

/** Mailosaur stores copies forwarded from Resend; show one message, not two. */
const fingerprint = (n: Notification) =>
  [
    n.channel,
    n.namespace,
    n.to.toLowerCase(),
    n.from.address.toLowerCase(),
    n.email?.subject ?? "",
    n.preview,
  ].join("\u0000")

const dedupe = (items: Notification[]): Notification[] => {
  const senders = new Map<string, number[]>()
  for (const n of items)
    if (n.service !== "mailosaur") {
      const key = fingerprint(n)
      senders.set(key, [...(senders.get(key) ?? []), Date.parse(n.createdAt)])
    }
  return items.filter((n) => {
    if (n.service !== "mailosaur") return true
    const at = Date.parse(n.createdAt)
    return !(senders.get(fingerprint(n)) ?? []).some((t) => Math.abs(t - at) <= DUPLICATE_WINDOW_MS)
  })
}

const byTime = (a: Notification, b: Notification) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1

export const createNotificationHarness = (options: HarnessOptions = {}): NotificationHarness => {
  if (!options.fleet && !options.manifest && !options.services)
    throw new Error("createNotificationHarness: pass fleet, manifest or services")
  const fetchImpl: FetchLike = options.fetch ?? ((request) => fetch(request))
  const authHeaders: Record<string, string> = options.adminKey
    ? { "x-mockingbird-admin-key": options.adminKey }
    : {}
  const followAll = (options.namespaces ?? (options.fleet ? "all" : undefined)) === "all"
  const watched = new Set<string>(
    Array.isArray(options.namespaces) ? options.namespaces : ["default"],
  )
  const buckets = new Map<string, Bucket>()
  const statuses = new Map<string, SourceStatus>()
  const listeners = new Set<
    (event: { namespace: string; added: Notification[]; version: number }) => void
  >()
  const explicit = options.services ? endpointsFromServices(options.services, fetchImpl) : []
  let endpoints: Endpoint[] = explicit
  let discoveredAt = 0
  let discoveryError: string | null = null
  let discovering: Promise<void> | null = null
  /** Entries whose health route named a service the harness does not read (stripe, …). */
  const rejected = new Set<string>()

  const rediscover = async (force = false) => {
    if (!options.fleet && !options.manifest) return
    if (!force && Date.now() - discoveredAt < REDISCOVER_MS) return
    discovering ??= (async () => {
      try {
        let found: Endpoint[] = []
        if (options.fleet) {
          const fleet = await discoverFleet(options.fleet, fetchImpl, authHeaders)
          found = fleet.endpoints
          if (followAll) for (const ns of fleet.namespaces) watched.add(ns)
        } else if (options.manifest) {
          const manifest =
            typeof options.manifest === "function" ? await options.manifest() : options.manifest
          found = endpointsFromManifest(manifest, fetchImpl)
        }
        // Keep what we learned from health probes across rediscovery.
        const known = new Map(endpoints.map((e) => [`${e.name}|${e.adminUrl}`, e.service]))
        endpoints = [
          ...explicit,
          ...found
            .filter(
              (e) =>
                !explicit.some((x) => x.name === e.name) &&
                !rejected.has(`${e.name}|${e.adminUrl}`),
            )
            .map((e) => ({
              ...e,
              service: e.service ?? known.get(`${e.name}|${e.adminUrl}`) ?? null,
            })),
        ]
        discoveryError = null
      } catch (error) {
        discoveryError = error instanceof Error ? error.message : String(error)
      } finally {
        discoveredAt = Date.now()
        discovering = null
      }
    })()
    await discovering
  }

  const adminGet = (endpoint: Endpoint, namespace: string) => async (path: string) => {
    const response = await endpoint.fetch(
      new Request(`${endpoint.adminUrl}${path}`, {
        headers: {
          ...authHeaders,
          "x-mockingbird-namespace": namespace,
          accept: "application/json",
        },
      }),
    )
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`GET ${path}: HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    return response.json() as Promise<unknown>
  }

  /** Learn what an unnamed emulator is from its health route (`{ service: "fcm" }`). */
  const identify = async (endpoint: Endpoint): Promise<void> => {
    if (endpoint.service) return
    const health = (await adminGet(endpoint, "default")("/health")) as { service?: unknown }
    endpoint.service = asServiceKind(health.service)
    if (!endpoint.service) throw new Error(`not a messaging emulator (${String(health.service)})`)
  }

  const bucket = (namespace: string): Bucket => {
    let b = buckets.get(namespace)
    if (!b) {
      b = { notifications: new Map(), inFlight: null, queued: null, version: 0 }
      buckets.set(namespace, b)
    }
    return b
  }

  const readAll = async (namespace: string) => {
    await rediscover()
    const results = await Promise.all(
      endpoints.map(async (endpoint) => {
        const key = endpoint.name
        const status: SourceStatus = statuses.get(key) ?? {
          name: endpoint.name,
          service: endpoint.service,
          url: endpoint.adminUrl,
          ok: false,
          error: null,
          count: 0,
          lastSyncAt: null,
        }
        statuses.set(key, status)
        try {
          await identify(endpoint)
          const service = endpoint.service
          if (!service) return { ok: false as const }
          const items = await READERS[service]({
            source: endpoint.name,
            namespace,
            read: adminGet(endpoint, namespace),
          })
          Object.assign(status, {
            service,
            url: endpoint.adminUrl,
            ok: true,
            error: null,
            lastSyncAt: new Date().toISOString(),
          })
          return { ok: true as const, items }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // An emulator that answers but is not a messaging one is simply not shown.
          if (message.startsWith("not a messaging emulator")) {
            statuses.delete(key)
            rejected.add(`${endpoint.name}|${endpoint.adminUrl}`)
            endpoints = endpoints.filter((e) => e !== endpoint)
            return { ok: false as const }
          }
          Object.assign(status, { url: endpoint.adminUrl, ok: false, error: message })
          discoveredAt = 0
          return { ok: false as const, source: endpoint.name }
        }
      }),
    )
    const b = bucket(namespace)
    const failed = new Set(results.flatMap((r) => ("source" in r && r.source ? [r.source] : [])))
    const fresh = dedupe(results.flatMap((r) => (r.ok ? r.items : [])))
    const next = new Map<string, Notification>()
    // A source that failed this round keeps what it last showed rather than blinking out.
    for (const n of b.notifications.values()) if (failed.has(n.source)) next.set(n.id, n)
    for (const n of fresh) next.set(n.id, n)
    const added = [...next.values()].filter((n) => !b.notifications.has(n.id)).sort(byTime)
    const removed = [...b.notifications.keys()].some((id) => !next.has(id))
    const changed =
      added.length > 0 ||
      removed ||
      [...next.values()].some((n) => b.notifications.get(n.id)?.status !== n.status)
    b.notifications = next
    for (const status of statuses.values())
      status.count = [...buckets.values()].reduce(
        (sum, bk) =>
          sum + [...bk.notifications.values()].filter((n) => n.source === status.name).length,
        0,
      )
    if (changed) {
      b.version++
      for (const listener of listeners) listener({ namespace, added, version: b.version })
    }
  }

  const sync = (namespace = "default"): Promise<void> => {
    watched.add(namespace)
    const b = bucket(namespace)
    if (!b.inFlight) {
      b.inFlight = readAll(namespace).finally(() => {
        b.inFlight = null
      })
      return b.inFlight
    }
    // A read is running but may have started before the caller's send; queue one more.
    b.queued ??= b.inFlight.then(() => {
      b.queued = null
      return sync(namespace)
    })
    return b.queued
  }

  const list = async (filter: NotificationFilter = {}) => {
    const namespace = filter.namespace ?? "default"
    await sync(namespace)
    return [...bucket(namespace).notifications.values()]
      .filter((n) => matches(n, { ...filter, namespace }))
      .sort(byTime)
  }

  const waitFor = async (filter: NotificationFilter, wait: WaitOptions = {}) => {
    const timeoutMs = wait.timeoutMs ?? 10_000
    const count = wait.count ?? 1
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = await list(filter)
      if (found.length >= count) return found
      if (Date.now() >= deadline) {
        const error = new Error(
          `timed out after ${timeoutMs}ms waiting for ${count} notification(s) matching ${JSON.stringify(filter)}; found ${found.length}`,
        )
        Object.assign(error, { found })
        throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
      )
    }
  }

  const interval = options.pollIntervalMs ?? 750
  const timer =
    interval > 0
      ? setInterval(() => {
          for (const namespace of watched) void sync(namespace).catch(() => {})
        }, interval)
      : null
  ;(timer as { unref?: () => void } | null)?.unref?.()

  const events = (namespace: string, signal: AbortSignal) => {
    watched.add(namespace)
    const encoder = new TextEncoder()
    let cleanup = () => {}
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            cleanup()
          }
        }
        const listener = (event: { namespace: string; added: Notification[]; version: number }) => {
          if (event.namespace === namespace) send("change", event)
        }
        listeners.add(listener)
        const heartbeat = setInterval(() => send("sources", [...statuses.values()]), 2_000)
        cleanup = () => {
          listeners.delete(listener)
          clearInterval(heartbeat)
        }
        signal.addEventListener("abort", () => {
          cleanup()
          try {
            controller.close()
          } catch {}
        })
        send("hello", { namespace, version: bucket(namespace).version })
        void sync(namespace).catch(() => {})
      },
      cancel() {
        cleanup()
      },
    })
  }

  const namespacesList = () => [...new Set([...watched, ...buckets.keys()])].sort()

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    if (request.method !== "GET" && request.method !== "HEAD")
      return errorBody(405, "the notification harness is read-only")
    if (path === "/" || path === "/index.html")
      return new Response(renderPage({ title: options.title ?? "Notifications" }), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      })
    if (path === "/ui.js")
      return new Response(BROWSER_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      })
    if (path === "/api/health") return json(200, { status: "ok", sources: [...statuses.values()] })
    if (path === "/api/sources") {
      await rediscover()
      return json(200, {
        discoveryError,
        sources: endpoints.map(
          (e) =>
            statuses.get(e.name) ?? {
              name: e.name,
              service: e.service,
              url: e.adminUrl,
              ok: false,
              error: null,
              count: 0,
              lastSyncAt: null,
            },
        ),
        services: SERVICE_KINDS,
      })
    }
    if (path === "/api/namespaces") {
      await rediscover()
      return json(200, { namespaces: namespacesList() })
    }
    let filter: NotificationFilter
    try {
      filter = filterFromSearch(url.searchParams)
    } catch (error) {
      return errorBody(400, error instanceof Error ? error.message : String(error))
    }
    const namespace = filter.namespace ?? "default"
    if (path === "/api/events")
      return new Response(events(namespace, request.signal), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      })
    if (path === "/api/notifications") {
      const found = await list(filter)
      if (url.searchParams.get("order") === "newest") found.reverse()
      return json(200, { namespace, version: bucket(namespace).version, notifications: found })
    }
    if (path === "/api/notifications/latest") {
      const found = await list(filter)
      const latest = found.at(-1)
      return latest ? json(200, latest) : errorBody(404, "no notification matches")
    }
    if (path === "/api/wait") {
      const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? 10_000)
      const count = Number(url.searchParams.get("count") ?? 1)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000)
        return errorBody(400, "timeoutMs: expected 0–120000")
      if (!Number.isInteger(count) || count < 1)
        return errorBody(400, "count: expected a positive integer")
      try {
        return json(200, { namespace, notifications: await waitFor(filter, { timeoutMs, count }) })
      } catch (error) {
        return json(408, {
          error: {
            type: "mockingbird_notifications",
            message: error instanceof Error ? error.message : String(error),
          },
          notifications: (error as { found?: unknown }).found ?? [],
        })
      }
    }
    const one = /^\/api\/notifications\/(.+)$/.exec(path)
    if (one) {
      const id = decodeURIComponent(one[1] ?? "")
      const ns = id.split(":")[1] ?? namespace
      await sync(ns)
      const found = bucket(ns).notifications.get(id)
      return found ? json(200, found) : errorBody(404, `no notification ${id}`)
    }
    return errorBody(404, `no route ${path}`)
  }

  return {
    fetch: async (request) => {
      try {
        return await handle(request)
      } catch (error) {
        return errorBody(500, error instanceof Error ? error.message : String(error))
      }
    },
    sync,
    list,
    waitFor,
    sources: () => [...statuses.values()],
    close: () => {
      if (timer) clearInterval(timer)
      listeners.clear()
    },
  }
}
