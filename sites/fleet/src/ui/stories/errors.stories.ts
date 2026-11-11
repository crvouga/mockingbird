import type { Meta } from "@storybook/html-vite"
import { forbidden, notFound, signedIn, unavailable } from "./fixtures.js"
import { query } from "./story.js"

export default { title: "Errors" } satisfies Meta

/** An address the dashboard does not know. */
export const PageNotFound = query({ path: "/nowhere/at/all", routes: signedIn() })

/** An organization that does not exist, or that the person cannot see. */
export const OrganizationNotFound = query({
  path: "/orgs/org_gone",
  routes: { ...signedIn(), "GET /orgs/org_gone": notFound("Organization") },
})

export const ProjectNotFound = query({
  path: "/projects/prj_gone",
  routes: { ...signedIn(), "GET /projects/prj_gone": notFound("Project") },
})

export const FleetNotFound = query({
  path: "/fleets/flt_gone",
  routes: { ...signedIn(), "GET /fleets/flt_gone": notFound("Fleet") },
})

/** Any other failure while drawing a screen. */
export const SomethingWentWrong = query({
  path: "/orgs/org_acme",
  routes: { ...signedIn(), "GET /orgs/org_acme": unavailable },
})

/** The API refuses to show something the address names: a plain statement, not a failure. */
export const NoAccess = query({
  path: "/projects/prj_web",
  routes: { ...signedIn(), "GET /projects/prj_web": forbidden },
})
