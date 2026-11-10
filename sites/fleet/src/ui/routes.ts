/**
 * Every address the dashboard answers and every tab of an organization, declared once. The router
 * and the organization screen are built from these tables, and so is the list of screens that
 * must have a Storybook story (`test/stories.test.ts`).
 */

/** First path segment → screen. `id` says the screen needs a second segment to match. */
export const ROUTES = [
  { segment: "invite", screen: "invite", id: true },
  { segment: "orgs", screen: "org", id: true },
  { segment: "projects", screen: "project", id: true },
  { segment: "fleets", screen: "fleet", id: true },
  { segment: "account", screen: "account", id: false },
  { segment: "api-reference", screen: "api-reference", id: false },
] as const

/** Anything no route matches (`/`, `/orgs`) is the list of organizations. */
export const FALLBACK_SCREEN = "home"

export type ScreenId = (typeof ROUTES)[number]["screen"] | typeof FALLBACK_SCREEN

/** What the page shows when it is not a screen: before, instead of, or in place of one. */
export const SHELL_STATES = [
  "boot",
  "unavailable",
  "sign-in",
  "not-found",
  "forbidden",
  "error",
] as const

export const SCREENS: readonly ScreenId[] = [
  FALLBACK_SCREEN,
  ...ROUTES.map((route) => route.screen),
]

/** Tabs of an organization, in display order. `admin` tabs are shown to admins and owners only. */
export const ORG_TABS = [
  { id: "projects", label: "Projects", admin: false },
  { id: "members", label: "Members", admin: false },
  { id: "usage", label: "Usage", admin: false },
  { id: "keys", label: "API keys", admin: true },
  { id: "audit", label: "Audit log", admin: true },
  { id: "settings", label: "Settings", admin: true },
] as const

export type OrgTabId = (typeof ORG_TABS)[number]["id"]

export type Route = { screen: ScreenId; id: string; tab: string }

export function matchRoute(path: string): Route {
  const [, first, id = "", tab] = path.split("/")
  const route = ROUTES.find((route) => route.segment === first && (id || !route.id))
  return { screen: route?.screen ?? FALLBACK_SCREEN, id, tab: tab ?? "projects" }
}

/** The tab an organization address shows; an unknown one shows the projects. */
export const orgTab = (tab: string): OrgTabId =>
  ORG_TABS.find((entry) => entry.id === tab)?.id ?? "projects"
