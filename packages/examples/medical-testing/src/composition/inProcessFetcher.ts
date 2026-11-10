import type { Hono } from "hono"
import { SESSION_HEADER } from "../app/auth/session.js"
import type { AppEnv } from "../app/http/appEnv.js"
import type { Fetcher } from "../client/api.js"

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
