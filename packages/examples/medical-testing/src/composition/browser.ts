import type { Hono } from "hono"
import { SESSION_HEADER } from "../app/auth/session.js"
import type { AppEnv } from "../app/http/appEnv.js"
import { type Fetcher, setFetcher } from "../client/api.js"
import { mountApp } from "../client/main.js"
import { STYLES } from "../client/theme.js"
import { buildApp } from "./build.js"

const NO_CLIENT_ASSETS = { html: "", js: "" }

/**
 * `app.request(path, init)` is Hono's own in-process call — no socket, works
 * identically in Bun and in a browser tab. Session state can't ride on a
 * real `Cookie`/`Set-Cookie` header here: browsers block JS from *reading*
 * `Set-Cookie` on any Response/Headers object, even a purely in-process one
 * with no network hop behind it. `SESSION_HEADER` is a plain, unrestricted
 * header carrying the same token instead — see app/http/app.ts's middleware.
 */
export const createInProcessFetcher = (app: Hono<AppEnv>): Fetcher => {
  let session = ""
  return async (path, init) => {
    const headers = new Headers(init?.headers)
    if (session) headers.set(SESSION_HEADER, session)
    const response = await app.request(path, { ...init, headers })
    if (response.headers.has(SESSION_HEADER)) session = response.headers.get(SESSION_HEADER) ?? ""
    return response
  }
}

/**
 * Boots a fresh in-process instance of the whole app and mounts the SPA
 * into `host`. Everything below runs in this JS heap — no server to start,
 * no real network call anywhere, including to any third-party provider.
 *
 * `setFetcher` is a module-level global in client/api.ts, so only mount one
 * instance of this app on a page at a time.
 */
export const mount = async (host: HTMLElement): Promise<() => void> => {
  const app = await buildApp(NO_CLIENT_ASSETS)
  setFetcher(createInProcessFetcher(app))

  const styleId = "cove-app-styles"
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style")
    style.id = styleId
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  const container = document.createElement("div")
  host.appendChild(container)
  mountApp(container)

  return () => {
    container.remove()
  }
}
