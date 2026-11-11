import { buildDemo, type Demo } from "./build.js"
import { buildClientAssets } from "./buildClientAssets.js"

const PORT = Number(process.env.PORT ?? 4300)

/** Where the notification harness is served on the standalone server. */
export const NOTIFICATIONS_PATH = "/notifications"

/**
 * One Fetch handler for the standalone server: the notification harness under
 * `/notifications/`, the app everywhere else. The harness page loads
 * `./ui.js` and `./api/...` relative to itself, so `/notifications` redirects
 * to `/notifications/` and the prefix is stripped before the harness sees it.
 */
export const createServerFetch =
  (demo: Pick<Demo, "app" | "notifications">) =>
  (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === NOTIFICATIONS_PATH)
      return Response.redirect(new URL(`${NOTIFICATIONS_PATH}/${url.search}`, url), 308)
    if (url.pathname.startsWith(`${NOTIFICATIONS_PATH}/`)) {
      url.pathname = url.pathname.slice(NOTIFICATIONS_PATH.length)
      return demo.notifications.fetch(new Request(url, request))
    }
    return demo.app.fetch(request)
  }

export const runStandaloneServer = async (): Promise<void> => {
  const assets = await buildClientAssets()
  const demo = await buildDemo(assets)
  // The harness streams server-sent events; keep those connections open.
  Bun.serve({ port: PORT, idleTimeout: 0, fetch: createServerFetch(demo) })
  console.log(`Example app is running at http://localhost:${PORT}`)
  console.log(
    `Notifications (email, text, push, chat) at http://localhost:${PORT}${NOTIFICATIONS_PATH}/`,
  )
}
