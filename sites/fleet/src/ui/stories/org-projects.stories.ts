import type { Meta } from "@storybook/html-vite"
import { inOrg, projects, suspended } from "./fixtures.js"
import { ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organization/Projects" } satisfies Meta

const listed = { "GET /orgs/org_acme/projects": ok({ data: projects }) }

export const Populated = story({ path: "/orgs/org_acme", routes: { ...inOrg("owner"), ...listed } })

export const Empty = story({
  path: "/orgs/org_acme",
  routes: { ...inOrg("owner"), "GET /orgs/org_acme/projects": ok({ data: [] }) },
})

export const AsAdmin = story({ path: "/orgs/org_acme", routes: { ...inOrg("admin"), ...listed } })

/** A member sees three tabs and can create projects. */
export const AsMember = story({ path: "/orgs/org_acme", routes: { ...inOrg("member"), ...listed } })

/** A viewer cannot create a project. */
export const AsViewer = story({ path: "/orgs/org_acme", routes: { ...inOrg("viewer"), ...listed } })

const frozen = inOrg("owner", { suspended: "unpaid invoice" })

/** The operator suspended the organization: a banner on every tab. */
export const Suspended = story({ path: "/orgs/org_acme", routes: { ...frozen, ...listed } })

/** Creating something while suspended: the refusal appears under the banner, which stays. */
export const SuspendedCreateRefused = story({
  path: "/orgs/org_acme",
  routes: {
    ...frozen,
    ...listed,
    "POST /orgs/org_acme/projects": suspended("unpaid invoice"),
  },
  steps: async (page) => {
    page.type("Project name", "Checkout")
    await page.press("Create project")
  },
  shows: ["flash"],
})
