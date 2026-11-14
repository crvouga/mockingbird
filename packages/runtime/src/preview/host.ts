import { attachPreviewHost, type PreviewPort } from "./bridge.js"
import type { FetchHandler } from "./types.js"

export type PreviewApplication = { fetch: FetchHandler; dispose(): void | Promise<void> }
export type PreviewState = {
  generation: number
  status: "starting" | "ready" | "error" | "disposed"
  error?: string
}

/** Shared application lifetime, independent of any single page connection. */
export function createPreviewHost(
  create: (generation: number) => Promise<PreviewApplication> | PreviewApplication,
) {
  let state: PreviewState = { generation: 0, status: "starting" }
  let application: PreviewApplication | undefined
  let closed = false
  const clients = new Set<ReturnType<typeof attachPreviewHost>>()
  let work: Promise<void> = Promise.resolve()
  const reset = () => {
    if (closed) return Promise.reject(new Error("Preview host disposed"))
    work = work
      .catch(() => undefined)
      .then(async () => {
        if (closed) return
        state = { generation: state.generation + 1, status: "starting" }
        try {
          const previous = application
          application = undefined
          await previous?.dispose()
          const next = await create(state.generation)
          if (closed) {
            await next.dispose()
            return
          }
          application = next
          state = { generation: state.generation, status: "ready" }
        } catch (error) {
          state = { generation: state.generation, status: "error", error: String(error) }
          throw error
        }
      })
    return work
  }
  const ready = reset()
  const fetch: FetchHandler = async (request) => {
    await work
    if (closed || !application) throw new Error("Preview host unavailable")
    return application.fetch(request)
  }
  return {
    ready,
    fetch,
    reset,
    state: () => ({ ...state }),
    connect(port: PreviewPort) {
      if (closed) throw new Error("Preview host disposed")
      const client = attachPreviewHost(port, fetch, { onDisconnect: () => clients.delete(client) })
      clients.add(client)
      return () => {
        client.dispose()
        clients.delete(client)
      }
    },
    async dispose() {
      if (closed) return
      closed = true
      for (const client of clients) client.dispose()
      clients.clear()
      await work.catch(() => undefined)
      await application?.dispose()
      application = undefined
      state = { generation: state.generation, status: "disposed" }
    },
  }
}
