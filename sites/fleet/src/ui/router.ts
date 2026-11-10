/** Draws the screen for the current address inside the page chrome. */
import { type Child, h } from "./dom.js"
import { matchRoute, type Route, type ScreenId } from "./routes.js"
import {
  type Address,
  ApiError,
  act,
  api,
  browserAddress,
  busy,
  link,
  noAccess,
  ui,
} from "./runtime.js"
import { account } from "./screens/account.js"
import { fleetScreen } from "./screens/fleet.js"
import { home } from "./screens/home.js"
import { orgScreen } from "./screens/org.js"
import { projectScreen } from "./screens/project.js"
import { reference } from "./screens/reference.js"
import { signIn } from "./screens/sign-in.js"
import type { Config, Me, Org } from "./types.js"

/** Accepting an invite is an API call, not a page: it lands on the organization joined. */
async function invite(token: string) {
  const org = await api<Org>("POST", "/invites/accept", { token })
  ui.address.replace(`/orgs/${org.id}`)
  return render()
}

const SCREEN: Record<Exclude<ScreenId, "invite">, (me: Me, route: Route) => Promise<Child>> = {
  org: (me, route) => orgScreen(me, route.id, route.tab),
  project: (_me, route) => projectScreen(route.id),
  fleet: (_me, route) => fleetScreen(route.id),
  account: (me) => account(me),
  "api-reference": () => reference(),
  home: (me) => home(me),
}

/** The API could not be asked who is signed in, so there is nothing to draw: say so, offer a retry. */
function unavailable(error: unknown) {
  return h(
    ".unavailable",
    { role: "alert" },
    h("h1", {}, "Mockingbird Fleet is not responding"),
    h(
      "p",
      {},
      error instanceof ApiError
        ? error.message
        : "The server could not be reached. Check your connection and that the server is running.",
    ),
    h("button.primary", { type: "button", onclick: act(async () => {}) }, "Try again"),
  )
}

/** Counts draws, so one that was overtaken by a newer one leaves the page alone. */
let draws = 0

export const render = (): Promise<void> => busy(draw)

async function draw(): Promise<void> {
  const turn = ++draws
  // Only the newest draw may touch the page: a slower, older one would put back a stale screen.
  const show = (...nodes: HTMLElement[]) => {
    if (turn === draws) ui.root.replaceChildren(...nodes)
  }
  const path = ui.address.path()
  if (path !== ui.lastPath) ui.revealed = undefined
  ui.lastPath = path
  let me: Me
  try {
    me = await api<Me>("GET", "/me")
  } catch (error) {
    try {
      if ((error as ApiError).status !== 401) throw error
      show(await signIn(await api<Config>("GET", "/config")))
    } catch (failure) {
      show(unavailable(failure))
    }
    return
  }
  const route = matchRoute(path)
  let screen: Child
  try {
    if (route.screen === "invite") return await invite(route.id)
    screen = await SCREEN[route.screen](me, route)
  } catch (error) {
    const status = (error as ApiError).status
    screen =
      status === 403
        ? noAccess((error as Error).message)
        : h(
            ".empty",
            { role: "alert" },
            h("strong", {}, status === 404 ? "Not found" : "Something went wrong"),
            (error as Error).message,
          )
  }
  show(
    h(
      "header.top",
      {},
      link("/orgs", { class: "brand" }, "Mockingbird ", h("span", {}, "Fleet")),
      h(
        "nav.topnav",
        { "aria-label": "Account" },
        link("/api-reference", { class: "navlink" }, "API"),
        link("/account", { class: "navlink", title: me.user?.email ?? "" }, "Account"),
        h(
          "button.linkish",
          { type: "button", onclick: act(() => api("POST", "/auth/logout")) },
          "Sign out",
        ),
      ),
    ),
    h("main", {}, screen),
  )
}

/**
 * Show the dashboard in `root` and draw the screen for the current address. The page mounts it on
 * the browser's own address bar; Storybook mounts it on an address held in memory.
 */
export function mount(root: HTMLElement, address: Address = browserAddress): Promise<void> {
  Object.assign(ui, {
    root,
    address,
    render,
    revealed: undefined,
    catalog: undefined,
    lastPath: undefined,
  })
  return render()
}
