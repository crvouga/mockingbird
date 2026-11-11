/**
 * Every address the dashboard answers, declared once. Each route is one surface and says what
 * kind it is:
 *
 * - `query`: shows data and links. No form, no control that changes anything on the server.
 * - `mutation`: exactly one form with exactly one submit button, plus a Cancel link.
 *
 * The router, the organization's tabs and the list of screens that must have Storybook stories
 * (`test/stories.test.ts`) are all built from this table; `audit.ts` checks a drawn surface
 * against its kind.
 */

export const ROUTE_KINDS = ["query", "mutation"] as const
export type RouteKind = (typeof ROUTE_KINDS)[number]

type Declared = {
  /** Stable name of the surface; drawn screens carry it as `data-route`. */
  id: string
  /** `:name` segments are parameters. */
  path: string
  kind: RouteKind
  /** The screen's heading. `{…}` stands for the name of the thing shown or acted on. */
  title: string
  /** Shown to people who are not signed in (everything else sends them to sign in). */
  public?: true
  /** The lowest organization role that may open it; absent means any member of it, or anyone. */
  role?: "member" | "admin" | "owner"
  /** Mutations: the form's fields, each of which can be reported wrong on its own. */
  fields?: readonly string[]
  /** Mutations that create a secret: the route that shows it, once. */
  result?: string
}

export const ROUTES = [
  // ---- signing in and out
  {
    id: "sign-in",
    path: "/sign-in",
    kind: "query",
    title: "Sign in to Mockingbird Fleet",
    public: true,
  },
  {
    id: "sign-in.local",
    path: "/sign-in/local",
    kind: "mutation",
    title: "Sign in locally",
    public: true,
    fields: ["email"],
  },
  {
    id: "sign-in.token",
    path: "/sign-in/token",
    kind: "mutation",
    title: "Sign in with a token",
    public: true,
    fields: ["token"],
  },
  { id: "sign-out", path: "/sign-out", kind: "mutation", title: "Sign out" },

  // ---- organizations
  { id: "orgs", path: "/orgs", kind: "query", title: "Organizations" },
  {
    id: "org.new",
    path: "/orgs/new",
    kind: "mutation",
    title: "New organization",
    fields: ["name"],
  },
  { id: "org", path: "/orgs/:org", kind: "query", title: "{organization}" },
  {
    id: "org.configuration",
    path: "/orgs/:org/configuration",
    kind: "query",
    title: "{organization}",
  },
  {
    id: "org.configuration.release",
    path: "/orgs/:org/configuration/release",
    kind: "mutation",
    title: "Release {organization} from mockingbird.yaml",
    role: "admin",
  },
  { id: "org.members", path: "/orgs/:org/members", kind: "query", title: "{organization}" },
  { id: "org.usage", path: "/orgs/:org/usage", kind: "query", title: "{organization}" },
  {
    id: "org.keys",
    path: "/orgs/:org/keys",
    kind: "query",
    title: "{organization}",
    role: "admin",
  },
  {
    id: "org.audit",
    path: "/orgs/:org/audit",
    kind: "query",
    title: "{organization}",
    role: "admin",
  },
  {
    id: "org.settings",
    path: "/orgs/:org/settings",
    kind: "query",
    title: "{organization}",
    role: "admin",
  },
  {
    id: "org.rename",
    path: "/orgs/:org/rename",
    kind: "mutation",
    title: "Rename {organization}",
    role: "admin",
    fields: ["name"],
  },
  {
    id: "org.delete",
    path: "/orgs/:org/delete",
    kind: "mutation",
    title: "Delete {organization}",
    role: "owner",
    fields: ["confirm"],
  },
  { id: "org.leave", path: "/orgs/:org/leave", kind: "mutation", title: "Leave {organization}" },

  // ---- members and invites
  {
    id: "member.role",
    path: "/orgs/:org/members/:user/role",
    kind: "mutation",
    title: "Change the role of {member}",
    role: "admin",
    fields: ["role"],
  },
  {
    id: "member.remove",
    path: "/orgs/:org/members/:user/remove",
    kind: "mutation",
    title: "Remove {member} from {organization}",
    role: "admin",
  },
  {
    id: "invite.new",
    path: "/orgs/:org/invites/new",
    kind: "mutation",
    title: "Invite someone to {organization}",
    role: "admin",
    fields: ["email", "role"],
    result: "invite.created",
  },
  {
    id: "invite.created",
    path: "/orgs/:org/invites/:invite/created",
    kind: "query",
    title: "Invite link created",
    role: "admin",
  },
  {
    id: "invite.revoke",
    path: "/orgs/:org/invites/:invite/revoke",
    kind: "mutation",
    title: "Revoke the invite for {email}",
    role: "admin",
  },
  { id: "invite.accept", path: "/invite/:token", kind: "mutation", title: "Join an organization" },

  // ---- API keys
  {
    id: "key.new",
    path: "/orgs/:org/keys/new",
    kind: "mutation",
    title: "New API key",
    role: "admin",
    fields: ["name", "projectId", "role"],
    result: "key.created",
  },
  {
    id: "key.created",
    path: "/orgs/:org/keys/:key/created",
    kind: "query",
    title: "API key created",
    role: "admin",
  },
  {
    id: "key.revoke",
    path: "/orgs/:org/keys/:key/revoke",
    kind: "mutation",
    title: "Revoke the API key {key}",
    role: "admin",
  },

  // ---- projects
  {
    id: "project.new",
    path: "/orgs/:org/projects/new",
    kind: "mutation",
    title: "New project",
    role: "member",
    fields: ["name"],
  },
  { id: "project", path: "/projects/:project", kind: "query", title: "{project}" },
  {
    id: "project.rename",
    path: "/projects/:project/rename",
    kind: "mutation",
    title: "Rename {project}",
    role: "member",
    fields: ["name"],
  },
  {
    id: "project.delete",
    path: "/projects/:project/delete",
    kind: "mutation",
    title: "Delete {project}",
    role: "admin",
  },

  // ---- fleets
  {
    id: "fleet.new",
    path: "/projects/:project/fleets/new",
    kind: "mutation",
    title: "New fleet",
    role: "member",
    fields: ["name", "slug"],
  },
  { id: "fleet", path: "/fleets/:fleet", kind: "query", title: "{fleet}" },
  {
    id: "fleet.rename",
    path: "/fleets/:fleet/rename",
    kind: "mutation",
    title: "Rename {fleet}",
    role: "member",
    fields: ["name"],
  },
  {
    id: "fleet.access",
    path: "/fleets/:fleet/access",
    kind: "mutation",
    title: "Change who can call {fleet}",
    role: "member",
    fields: ["access"],
  },
  {
    id: "fleet.rate-limit",
    path: "/fleets/:fleet/rate-limit",
    kind: "mutation",
    title: "Change the requests per minute of {fleet}",
    role: "member",
    fields: ["requestsPerMinute"],
  },
  {
    id: "fleet.delete",
    path: "/fleets/:fleet/delete",
    kind: "mutation",
    title: "Delete {fleet}",
    role: "member",
  },

  // ---- emulators
  {
    id: "emulator.add",
    path: "/fleets/:fleet/add-emulator",
    kind: "query",
    title: "Add an emulator to {fleet}",
    role: "member",
  },
  {
    id: "emulator.add.configure",
    path: "/fleets/:fleet/add-emulator/:target",
    kind: "mutation",
    title: "Add {emulator} to {fleet}",
    role: "member",
    fields: ["name", "durability"],
  },
  {
    id: "emulator.durability",
    path: "/fleets/:fleet/emulators/:name/durability",
    kind: "mutation",
    title: "Change the durability of {emulator}",
    role: "member",
    fields: ["durability"],
  },
  {
    id: "emulator.save",
    path: "/fleets/:fleet/emulators/:name/save",
    kind: "mutation",
    title: "Save {emulator} now",
    role: "member",
  },
  {
    id: "emulator.reset",
    path: "/fleets/:fleet/emulators/:name/reset",
    kind: "mutation",
    title: "Reset {emulator}",
    role: "member",
  },
  {
    id: "emulator.remove",
    path: "/fleets/:fleet/emulators/:name/remove",
    kind: "mutation",
    title: "Remove {emulator} from {fleet}",
    role: "member",
  },

  // ---- account
  { id: "account", path: "/account", kind: "query", title: "Account" },
  {
    id: "token.new",
    path: "/account/tokens/new",
    kind: "mutation",
    title: "New personal token",
    fields: ["name"],
    result: "token.created",
  },
  {
    id: "token.created",
    path: "/account/tokens/:token/created",
    kind: "query",
    title: "Personal token created",
  },
  {
    id: "token.revoke",
    path: "/account/tokens/:token/revoke",
    kind: "mutation",
    title: "Revoke the personal token {token}",
  },

  { id: "api-reference", path: "/api-reference", kind: "query", title: "API reference" },
] as const satisfies readonly Declared[]

export type RouteId = (typeof ROUTES)[number]["id"]
export type RouteDef = Declared & { id: RouteId }

/** `/` is the list of organizations (which opens the first one when there is one). */
export const HOME: RouteId = "orgs"

/** What the page shows when it is not a route's screen: before, instead of, or in place of one. */
export const SHELL_STATES = [
  "boot",
  "unavailable",
  "not-found",
  "forbidden",
  "error",
  "gone",
  /** The address of a hand edit that `mockingbird.yaml` controls in this organization. */
  "managed",
] as const

/** Every surface the page can show that is not a route is a query: text and links only. */
export const SHELL_KIND: RouteKind = "query"

export const route = (id: RouteId): RouteDef => ROUTES.find((entry) => entry.id === id) as RouteDef

/** Tabs of an organization, in display order. `admin` tabs are shown to admins and owners only. */
export const ORG_TABS = [
  { id: "projects", label: "Projects", route: "org", admin: false },
  { id: "configuration", label: "Configuration", route: "org.configuration", admin: false },
  { id: "members", label: "Members", route: "org.members", admin: false },
  { id: "usage", label: "Usage", route: "org.usage", admin: false },
  { id: "keys", label: "API keys", route: "org.keys", admin: true },
  { id: "audit", label: "Audit log", route: "org.audit", admin: true },
  { id: "settings", label: "Settings", route: "org.settings", admin: true },
] as const satisfies readonly { id: string; label: string; route: RouteId; admin: boolean }[]

export type OrgTabId = (typeof ORG_TABS)[number]["id"]

export type Match = { route: RouteDef; params: Record<string, string> }

/** The route an address names, or undefined when it names none. */
export function matchRoute(path: string): Match | undefined {
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return { route: route(HOME), params: {} }
  for (const entry of ROUTES) {
    const pattern = entry.path.split("/").filter(Boolean)
    if (pattern.length !== segments.length) continue
    const params: Record<string, string> = {}
    const fits = pattern.every((part, index) => {
      const segment = segments[index] as string
      if (!part.startsWith(":")) return part === segment
      params[part.slice(1)] = decodeURIComponent(segment)
      return true
    })
    if (fits) return { route: entry, params }
  }
  return undefined
}

/** The address of a route: `to("fleet.rename", { fleet: "flt_1" })`. */
export function to(id: RouteId, params: Record<string, string> = {}): string {
  return route(id).path.replace(/:([a-z]+)/g, (_all, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  )
}

/** A route's heading with its names filled in: `titleOf(route, { fleet: "Staging" })`. */
export const titleOf = (entry: RouteDef, names: Record<string, string> = {}): string =>
  entry.title.replace(/\{([a-z]+)\}/g, (_all, name: string) => names[name] ?? "")
