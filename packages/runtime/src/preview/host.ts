import { createPreviewHost as createHost } from "@crvouga/mockingbird-preview"
import { attachPreviewHost, type PreviewPort } from "./bridge.js"
import type { FetchHandler } from "./types.js"

export type PreviewApplication = { fetch: FetchHandler; dispose(): void | Promise<void> }
export type PreviewState = {
  generation: number
  status: "starting" | "ready" | "error" | "disposed"
  error?: string
}

/** Preserve the original generation numbering and promise-shaped readiness on the shared host. */
export function createPreviewHost(
  create: (generation: number) => Promise<PreviewApplication> | PreviewApplication,
) {
  let failure: unknown
  const host = createHost({
    artifact: "runtime-preview-compatibility",
    boot: async ({ generation }) => {
      failure = undefined
      try {
        return await create(generation + 1)
      } catch (error) {
        failure = error
        throw error
      }
    },
  })
  const checked = async (work: Promise<void>) => {
    await work
    if (host.status().state === "failed") throw failure ?? new Error("Preview host unavailable")
  }
  const ready = checked(host.ready())
  const clients = new Set<ReturnType<typeof attachPreviewHost>>()
  const fetch: FetchHandler = async (request) => {
    await checked(host.ready())
    if (host.status().state === "disposed") throw new Error("Preview host unavailable")
    return host.fetch(request)
  }
  return {
    ready,
    fetch,
    reset: () => checked(host.reset()),
    state(): PreviewState {
      const current = host.status()
      return {
        generation: current.generation + 1,
        status: current.state === "failed" ? "error" : current.state,
        ...(current.state === "failed"
          ? { error: String(failure ?? "Preview host unavailable") }
          : {}),
      }
    },
    connect(port: PreviewPort) {
      if (host.status().state === "disposed") throw new Error("Preview host disposed")
      const client = attachPreviewHost(port, fetch, { onDisconnect: () => clients.delete(client) })
      clients.add(client)
      return () => {
        client.dispose()
        clients.delete(client)
      }
    },
    async dispose() {
      for (const client of clients) client.dispose()
      clients.clear()
      await host.dispose()
    },
  }
}
