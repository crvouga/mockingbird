import { listenPreview } from "@crvouga/mockingbird-preview/node"
import type { WebFetch } from "./types.js"

/** Keep the original logical-origin routing while using the shared HTTP adapter. */
export async function startPreviewHarness(
  fetch: WebFetch,
  options: { origin: string; port?: number },
) {
  const origin = new URL(options.origin)
  return listenPreview(
    (request) => {
      const path = new URL(request.url)
      const url = new URL(origin)
      url.pathname = path.pathname
      url.search = path.search
      return fetch(new Request(url, request))
    },
    { ...(options.port !== undefined ? { port: options.port } : {}) },
  )
}
