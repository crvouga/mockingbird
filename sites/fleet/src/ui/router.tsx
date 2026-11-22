/** Draws the surface for the current address inside the page chrome. */

import {
  AppShell,
  CenteredCard,
  LoadingState,
  MockingbirdProvider,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react"
import { Alert } from "@heroui/react"
import { Fragment } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { action, type Child, Code, FILE, Head, Links, Narrow } from "./kit.js"
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
  followLinks,
  ManagedError,
  moment,
  returnTo,
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

/** The product's name beside the Mockingbird wordmark. */
const PRODUCT = "Fleet Cloud"

type Statement = {
  title: string
  body: Child
  links: Child
  tone?: "danger" | "warning" | "accent"
}

/**
 * A screen-sized statement: nothing here, not found, no access. Signed in, it sits in the page
 * chrome; signed out, it is the one card on the page.
 */
function statement({ title, body, links, tone = "warning" }: Statement, signedIn: boolean) {
  if (!signedIn)
    return <CenteredCard title={title} description={body} product={PRODUCT} footer={links} />
  return (
    <Narrow>
      <Head title={title} />
      <Alert status={tone}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description className="break-words">{body}</Alert.Description>
        </Alert.Content>
      </Alert>
      <Links>{links}</Links>
    </Narrow>
  )
}

const again = () => ui.address.path() + ui.address.search()

/** The API could not be asked who is signed in, so there is nothing to draw: say so. */
const unavailable = (error: unknown): Statement => ({
  title: "Mockingbird Fleet is not responding",
  body:
    error instanceof ApiError
      ? error.message
      : "The server could not be reached. Check your connection and that the server is running.",
  links: action(again(), "Try again", "primary"),
  tone: "danger",
})

/** The address of a hand edit in an organization its `mockingbird.yaml` controls: read-only. */
const managed = ({ org, what, back }: ManagedError): Statement => ({
  title: `This is configured by ${FILE}`,
  body: (
    <>
      {what} is not available by hand in {org.name}. Its projects, fleets and emulators are declared
      in <Code>{FILE}</Code>
      {org.managed
        ? `, last applied ${moment(org.managed.appliedAt)} by ${org.managed.appliedBy}. `
        : ". "}
      Change the file and apply it instead.
    </>
  ),
  links: (
    <>
      {action(to("org.configuration", { org: org.id }), "How to change it", "primary")}
      {action(back.href, back.label)}
    </>
  ),
  tone: "accent",
})

/** A screen could not be drawn: say what happened in its place. */
function failed(error: unknown): { state: string; body: Statement } {
  if (error instanceof ManagedError) return { state: "managed", body: managed(error) }
  const status = (error as ApiError).status
  const message = (error as Error).message
  const back = action(to("orgs"), "Go to your organizations")
  if (status === 403)
    return {
      state: "forbidden",
      body: { title: "You do not have access", body: message, links: back },
    }
  if (status === 404)
    return { state: "not-found", body: { title: "Not found", body: message, links: back } }
  if (status === 410)
    return {
      state: "gone",
      body: { title: "This was shown once", body: message, links: back, tone: "accent" },
    }
  return {
    state: "error",
    body: {
      title: "Something went wrong",
      body: message,
      links: action(again(), "Try again"),
      tone: "danger",
    },
  }
}

/** The page around a surface: the top bar for someone signed in, nothing around a card otherwise. */
function Page({
  me,
  kind,
  name,
  turn,
  children,
}: {
  me: Me | undefined
  kind: RouteKind
  name: string
  /** A new one for every draw: nothing typed into the last surface is carried into this one. */
  turn: number
  children: Child
}) {
  const content = <Fragment key={turn}>{children}</Fragment>
  const surface = { "data-surface": kind, "data-route": name }
  if (!me) return <main {...surface}>{content}</main>
  const path = ui.address.path()
  const nav = [
    { label: "Organizations", href: to("orgs"), current: /^\/(orgs|projects|fleets)?(\/|$)/ },
    { label: "Account", href: to("account"), current: /^\/account/ },
    { label: "API", href: to("api-reference"), current: /^\/api-reference/ },
  ].map(({ current, ...item }) => ({ ...item, current: current.test(path) }))
  return (
    <AppShell
      product={PRODUCT}
      brandHref={to("orgs")}
      nav={nav}
      actions={
        <>
          <ThemeSwitch />
          <a
            href={to("sign-out")}
            title={me.user?.email ?? ""}
            className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted no-underline hover:bg-default hover:text-foreground"
          >
            Sign out
          </a>
        </>
      }
      mainProps={surface}
    >
      {content}
    </AppShell>
  )
}

/** Counts draws, so one that was overtaken by a newer one leaves the page alone. */
let draws = 0
/** The address last drawn: the heading takes the focus only when the address changed. */
let drawn: string | undefined
let root: Root | undefined

export const render = (): Promise<void> => busy(draw)

/** Back and Forward: an address reached again shows no leftovers of the last mutation. */
export function revisit(): Promise<void> {
  ui.note = undefined
  ui.secret = undefined
  return render()
}

/** Put a tree in the dashboard's root, at once, so the next line can look at what it drew. */
function paint(tree: Child) {
  flushSync(() => root?.render(<MockingbirdProvider>{tree}</MockingbirdProvider>))
}

async function draw(): Promise<void> {
  const turn = ++draws
  const path = ui.address.path()
  /** Put a surface on the page. Only the newest draw may: an older one would bring back a stale screen. */
  const show = (me: Me | undefined, kind: RouteKind, name: string, body: Child) => {
    if (turn !== draws) return
    paint(
      <Page turn={turn} me={me} kind={kind} name={name}>
        {body}
      </Page>,
    )
    const moved = drawn !== undefined && drawn !== path
    drawn = path
    const heading = ui.root.querySelector<HTMLElement>("main h1")
    if (moved && heading) {
      heading.tabIndex = -1
      heading.focus()
    }
  }

  let me: Me | undefined
  try {
    me = await api<Me>("GET", "/me")
  } catch (error) {
    if ((error as ApiError).status !== 401)
      return show(undefined, SHELL_KIND, "unavailable", statement(unavailable(error), false))
  }

  const match = matchRoute(path)
  if (!match)
    return show(
      me,
      SHELL_KIND,
      "not-found",
      statement(
        {
          title: "Page not found",
          body: `Nothing lives at ${path}.`,
          links: action(
            me ? to("orgs") : to("sign-in"),
            me ? "Go to your organizations" : "Go to sign-in",
          ),
        },
        Boolean(me),
      ),
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
      return show(undefined, route.kind, route.id, body)
    }
    const address = ui.address.path()
    const body = await SCREENS[route.id]({ me, route, params })
    // A screen may send the caller elsewhere (`/` opens the first organization): draw that.
    if (ui.address.path() !== address) return draw()
    show(me, route.kind, route.id, body)
  } catch (error) {
    if (!me && (error as ApiError).status !== 403)
      return show(undefined, SHELL_KIND, "unavailable", statement(unavailable(error), false))
    const { state, body } = failed(error)
    show(me, SHELL_KIND, state, statement(body, Boolean(me)))
  }
}

/**
 * Show the dashboard in `root` and draw the surface for the current address. The page mounts it
 * on the browser's own address bar; Storybook mounts it on an address held in memory.
 */
export function mount(element: HTMLElement, address: Address = browserAddress): Promise<void> {
  Object.assign(ui, {
    root: element,
    address,
    render,
    note: undefined,
    secret: undefined,
    catalog: undefined,
  })
  drawn = undefined
  root?.unmount()
  // React owns the element from here: what `index.html` put in it is replaced at once.
  element.replaceChildren()
  root = createRoot(element)
  followLinks(element)
  paint(<LoadingState />)
  return render()
}
