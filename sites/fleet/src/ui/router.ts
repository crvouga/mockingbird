/** Draws the surface for the current address inside the page chrome. */
import { type Child, h } from "./dom.js"
import {
  matchRoute,
  type RouteDef,
  type RouteId,
  type RouteKind,
  SHELL_KIND,
  to,
} from "./routes.js"
import {
  type Address,
  ApiError,
  api,
  browserAddress,
  busy,
  link,
  ManagedError,
  moment,
  returnTo,
  statement,
  ui,
} from "./runtime.js"
import { account, tokenCreated, tokenNew, tokenRevoke } from "./screens/account.js"
import { configurationRelease } from "./screens/configuration.js"
import {
  emulatorAdd,
  emulatorConfigure,
  emulatorDurability,
  emulatorRemove,
  emulatorReset,
  emulatorSave,
} from "./screens/emulators.js"
import {
  fleetAccess,
  fleetDelete,
  fleetNew,
  fleetRateLimit,
  fleetRename,
  fleetScreen,
} from "./screens/fleet.js"
import { home, orgNew } from "./screens/home.js"
import { inviteAccept } from "./screens/invite.js"
import { keyCreated, keyNew, keyRevoke } from "./screens/keys.js"
import {
  inviteCreated,
  inviteNew,
  inviteRevoke,
  memberRemove,
  memberRole,
  orgLeave,
} from "./screens/members.js"
import { orgDelete, orgRename, orgScreen } from "./screens/org.js"
import { projectDelete, projectNew, projectRename, projectScreen } from "./screens/project.js"
import { reference } from "./screens/reference.js"
import { signIn, signInLocal, signInToken, signOut } from "./screens/sign-in.js"
import type { Config, Me } from "./types.js"

/** What a screen is drawn from. `me` is absent on the screens for people who are signed out. */
export type Context = {
  me: Me
  route: RouteDef
  params: Record<string, string>
  /** Only on the screens for people who are signed out. */
  config?: Config
}
export type Screen = (context: Context) => Promise<Child> | Child

/** One screen per route: adding a route without one does not compile. */
const SCREENS: Record<RouteId, Screen> = {
  "sign-in": signIn,
  "sign-in.local": signInLocal,
  "sign-in.token": signInToken,
  "sign-out": signOut,
  orgs: home,
  "org.new": orgNew,
  org: orgScreen,
  "org.configuration": orgScreen,
  "org.configuration.release": configurationRelease,
  "org.members": orgScreen,
  "org.usage": orgScreen,
  "org.keys": orgScreen,
  "org.audit": orgScreen,
  "org.settings": orgScreen,
  "org.rename": orgRename,
  "org.delete": orgDelete,
  "org.leave": orgLeave,
  "member.role": memberRole,
  "member.remove": memberRemove,
  "invite.new": inviteNew,
  "invite.created": inviteCreated,
  "invite.revoke": inviteRevoke,
  "invite.accept": inviteAccept,
  "key.new": keyNew,
  "key.created": keyCreated,
  "key.revoke": keyRevoke,
  "project.new": projectNew,
  project: projectScreen,
  "project.rename": projectRename,
  "project.delete": projectDelete,
  "fleet.new": fleetNew,
  fleet: fleetScreen,
  "fleet.rename": fleetRename,
  "fleet.access": fleetAccess,
  "fleet.rate-limit": fleetRateLimit,
  "fleet.delete": fleetDelete,
  "emulator.add": emulatorAdd,
  "emulator.add.configure": emulatorConfigure,
  "emulator.durability": emulatorDurability,
  "emulator.save": emulatorSave,
  "emulator.reset": emulatorReset,
  "emulator.remove": emulatorRemove,
  account,
  "token.new": tokenNew,
  "token.created": tokenCreated,
  "token.revoke": tokenRevoke,
  "api-reference": reference,
}

/** Nobody is signed in: the only screens are the ways to sign in. */
const SIGNED_OUT: Me = { kind: "anonymous", orgs: [] }

/** The API could not be asked who is signed in, so there is nothing to draw: say so. */
const unavailable = (error: unknown) =>
  statement(
    "Mockingbird Fleet is not responding",
    error instanceof ApiError
      ? error.message
      : "The server could not be reached. Check your connection and that the server is running.",
    link(ui.address.path() + ui.address.search(), { class: "button primary" }, "Try again"),
  )

/** The address of a hand edit in an organization its `mockingbird.yaml` controls: read-only. */
const managed = ({ org, what, back }: ManagedError) =>
  statement(
    "This is configured by mockingbird.yaml",
    [
      `${what} is not available by hand in ${org.name}. Its projects, fleets and emulators are declared in `,
      h("code", {}, "mockingbird.yaml"),
      org.managed
        ? `, last applied ${moment(org.managed.appliedAt)} by ${org.managed.appliedBy}. `
        : ". ",
      "Change the file and apply it instead.",
    ],
    link(to("org.configuration", { org: org.id }), { class: "button primary" }, "How to change it"),
    link(back.href, { class: "button" }, back.label),
  )

/** A screen could not be drawn: say what happened in its place. */
function failed(error: unknown): { state: string; body: Child } {
  if (error instanceof ManagedError) return { state: "managed", body: managed(error) }
  const status = (error as ApiError).status
  const message = (error as Error).message
  const back = link(to("orgs"), { class: "button" }, "Go to your organizations")
  if (status === 403)
    return { state: "forbidden", body: statement("You do not have access", message, back) }
  if (status === 404) return { state: "not-found", body: statement("Not found", message, back) }
  if (status === 410)
    return { state: "gone", body: statement("This was shown once", message, back) }
  return {
    state: "error",
    body: statement(
      "Something went wrong",
      message,
      link(ui.address.path() + ui.address.search(), { class: "button" }, "Try again"),
    ),
  }
}

const header = (me: Me | undefined) =>
  h(
    "header.top",
    {},
    link(
      me ? to("orgs") : to("sign-in"),
      { class: "brand" },
      "Mockingbird ",
      h("span", {}, "Fleet"),
    ),
    me &&
      h(
        "nav.topnav",
        { "aria-label": "Account" },
        link(to("api-reference"), { class: "navlink" }, "API"),
        link(to("account"), { class: "navlink", title: me.user?.email ?? "" }, "Account"),
        link(to("sign-out"), { class: "navlink" }, "Sign out"),
      ),
  )

/** Counts draws, so one that was overtaken by a newer one leaves the page alone. */
let draws = 0
/** The address last drawn: the heading takes the focus only when the address changed. */
let drawn: string | undefined

export const render = (): Promise<void> => busy(draw)

/** Back and Forward: an address reached again shows no leftovers of the last mutation. */
export function revisit(): Promise<void> {
  ui.note = undefined
  ui.secret = undefined
  return render()
}

async function draw(): Promise<void> {
  const turn = ++draws
  const path = ui.address.path()
  /** Put a surface on the page. Only the newest draw may: an older one would bring back a stale screen. */
  const show = (
    me: Me | undefined,
    kind: RouteKind,
    name: string,
    body: Child,
    layout: "wide" | "narrow" = "wide",
  ) => {
    if (turn !== draws) return
    const main = h("main", { "data-surface": kind, "data-route": name, class: layout }, body)
    ui.root.replaceChildren(header(me), main)
    const moved = drawn !== undefined && drawn !== path
    drawn = path
    if (moved) main.querySelector<HTMLElement>("h1")?.focus()
  }

  let me: Me | undefined
  try {
    me = await api<Me>("GET", "/me")
  } catch (error) {
    if ((error as ApiError).status !== 401)
      return show(undefined, SHELL_KIND, "unavailable", unavailable(error), "narrow")
  }

  const match = matchRoute(path)
  if (!match)
    return show(
      me,
      SHELL_KIND,
      "not-found",
      statement(
        "Page not found",
        `Nothing lives at ${path}.`,
        link(
          me ? to("orgs") : to("sign-in"),
          { class: "button" },
          me ? "Go to your organizations" : "Go to sign-in",
        ),
      ),
      "narrow",
    )
  const { route, params } = match

  // Signed out, every address but the sign-in screens leads to sign-in, and back afterwards.
  if (!me && !route.public) {
    const back = route.id === "sign-out" ? "" : path + ui.address.search()
    ui.address.replace(
      back && back !== "/"
        ? `${to("sign-in")}?return_to=${encodeURIComponent(back)}`
        : to("sign-in"),
    )
    return draw()
  }
  // Signed in, there is nothing to do on a sign-in screen.
  if (me && route.public) {
    ui.address.replace(returnTo(ui.address.search()))
    return draw()
  }

  try {
    if (!me) {
      const config = await api<Config>("GET", "/config")
      const body = await SCREENS[route.id]({ me: SIGNED_OUT, route, params, config } as Context)
      return show(undefined, route.kind, route.id, body, "narrow")
    }
    const address = ui.address.path()
    const body = await SCREENS[route.id]({ me, route, params })
    // A screen may send the caller elsewhere (`/` opens the first organization): draw that.
    if (ui.address.path() !== address) return draw()
    const narrow = route.kind === "mutation" || route.id.endsWith(".created")
    show(me, route.kind, route.id, body, narrow ? "narrow" : "wide")
  } catch (error) {
    if (!me && (error as ApiError).status !== 403)
      return show(undefined, SHELL_KIND, "unavailable", unavailable(error), "narrow")
    const { state, body } = failed(error)
    show(me, SHELL_KIND, state, body, "narrow")
  }
}

/**
 * Show the dashboard in `root` and draw the surface for the current address. The page mounts it
 * on the browser's own address bar; Storybook mounts it on an address held in memory.
 */
export function mount(root: HTMLElement, address: Address = browserAddress): Promise<void> {
  Object.assign(ui, {
    root,
    address,
    render,
    note: undefined,
    secret: undefined,
    catalog: undefined,
  })
  drawn = undefined
  return render()
}
