import { type PreviewFetch, type PreviewPort, servePreviewPort } from "./bridge.js"

export type PreviewSystem = { fetch: PreviewFetch; dispose?: () => void | Promise<void> }
export type PreviewHostStatus = {
  state: "starting" | "ready" | "failed" | "disposed"
  generation: number
  artifact: string
  clients: number
}

/** Boot and reset are serialized. Each connection owns its requests, never the shared system. */
export function createPreviewHost(options: {
  artifact: string
  boot: (context: {
    generation: number
    signal: AbortSignal
  }) => PreviewSystem | Promise<PreviewSystem>
  allow?: (url: URL) => boolean
}) {
  if (!options.artifact) throw new Error("Preview artifact identity is required")
  let state: PreviewHostStatus["state"] = "starting"
  let generation = 0
  let system: PreviewSystem | undefined
  let abort = new AbortController()
  const clients = new Set<ReturnType<typeof servePreviewPort>>()
  const start = async () => {
    state = "starting"
    try {
      system = await options.boot({ generation, signal: abort.signal })
      if (abort.signal.aborted) {
        await system.dispose?.()
        system = undefined
        return
      }
      state = "ready"
    } catch {
      if (!abort.signal.aborted) state = "failed"
    }
  }
  let settled = start()
  const status = (): PreviewHostStatus => ({
    state,
    generation,
    artifact: options.artifact,
    clients: clients.size,
  })
  const disconnect = () => {
    for (const client of clients) client.dispose()
    clients.clear()
  }
  const fetch: PreviewFetch = async (request) => {
    await settled.catch(() => {})
    request.signal.throwIfAborted()
    if (state !== "ready" || !system)
      return Response.json({ error: "preview_not_ready", ...status() }, { status: 503 })
    return system.fetch(request)
  }
  const connect = (port: PreviewPort) => {
    if (state === "disposed") throw new Error("Preview host is disposed")
    const client = servePreviewPort(port, fetch, {
      ...(options.allow ? { allow: options.allow } : {}),
      onClose: () => clients.delete(client),
    })
    clients.add(client)
    return () => {
      clients.delete(client)
      client.dispose()
    }
  }
  const reset = () => {
    if (state === "disposed") return Promise.reject(new Error("Preview host is disposed"))
    disconnect()
    abort.abort()
    settled = settled
      .catch(() => {})
      .then(async () => {
        try {
          await system?.dispose?.()
          system = undefined
          if (state === "disposed") return
          generation++
          abort = new AbortController()
          await start()
        } catch (error) {
          if (state !== "disposed") state = "failed"
          throw error
        }
      })
    return settled
  }
  const dispose = async () => {
    state = "disposed"
    disconnect()
    abort.abort()
    await settled.catch(() => {})
    try {
      await system?.dispose?.()
      system = undefined
    } finally {
      state = "disposed"
    }
  }
  return { connect, fetch, reset, dispose, status, ready: () => settled }
}

export function sharedPreviewWorkerName(identity: {
  application: string
  artifact: string
  generation: number
}) {
  if (
    !identity.application ||
    !identity.artifact ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 0
  )
    throw new Error("Invalid preview worker identity")
  return JSON.stringify([
    "mockingbird-preview",
    identity.application,
    identity.artifact,
    identity.generation,
  ])
}
