import type { Meta } from "@storybook/html-vite"
import { forbidden, inOrg, notFound, type Role, signedIn, unavailable } from "./fixtures.js"
import { story } from "./story.js"

export default { title: "Errors" } satisfies Meta

/** An organization that does not exist, or that the person cannot see. */
export const NotFound = story({
  path: "/orgs/org_gone",
  routes: { ...signedIn(), "GET /orgs/org_gone": notFound("Organization") },
})

export const ProjectNotFound = story({
  path: "/projects/prj_gone",
  routes: { ...signedIn(), "GET /projects/prj_gone": notFound("Project") },
})

export const FleetNotFound = story({
  path: "/fleets/flt_gone",
  routes: { ...signedIn(), "GET /fleets/flt_gone": notFound("Fleet") },
})

/** Any other failure while drawing a screen. */
export const SomethingWentWrong = story({
  path: "/orgs/org_acme",
  routes: { ...signedIn(), "GET /orgs/org_acme": unavailable },
})

/** The API refuses to show something the address names: a plain statement, not a failure. */
export const NoAccess = story({
  path: "/projects/prj_web",
  routes: { ...signedIn(), "GET /projects/prj_web": forbidden },
})

const adminTab = (tab: string, role: Role) =>
  story({ path: `/orgs/org_acme/${tab}`, routes: inOrg(role) })

/** A viewer or member opens the address of a tab that is for admins: nothing is asked of the API. */
export const ApiKeysAsViewer = adminTab("keys", "viewer")
export const ApiKeysAsMember = adminTab("keys", "member")
export const AuditLogAsViewer = adminTab("audit", "viewer")
export const AuditLogAsMember = adminTab("audit", "member")
export const SettingsAsViewer = adminTab("settings", "viewer")
export const SettingsAsMember = adminTab("settings", "member")
