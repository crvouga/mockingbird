import {
  createPreviewClient as createClient,
  type PreviewPort,
  servePreviewPort,
} from "@crvouga/mockingbird-preview"
import type { FetchHandler } from "./types.js"

export type { PreviewPort }

/** Compatibility entry: explicit virtual cookie headers and error messages retain the original API. */
export function createPreviewClient(port: PreviewPort, options: { timeoutMs?: number } = {}) {
  return createClient(port, { ...options, cookies: true, exposeErrors: true })
}
export function attachPreviewHost(
  port: PreviewPort,
  fetch: FetchHandler,
  options: { onDisconnect?: () => void } = {},
) {
  return servePreviewPort(port, fetch, {
    cookies: true,
    exposeErrors: true,
    ...(options.onDisconnect ? { onClose: options.onDisconnect } : {}),
  })
}
