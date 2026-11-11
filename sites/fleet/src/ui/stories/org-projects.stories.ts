import type { Meta } from "@storybook/html-vite"
import { inOrg, invalid, projects, quotaExceeded, type Role, suspended } from "./fixtures.js"
import { created, type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Organization/Projects" } satisfies Meta

const path = "/orgs/org_acme"
const tab = (role: Role, list = projects, overrides = {}): MockRoutes => ({
  ...inOrg(role, overrides),
  "GET /orgs/org_acme/projects": ok({ data: list }),
})

export const AsOwner = query({ path, routes: tab("owner") })
export const AsAdmin = query({ path, routes: tab("admin") })
export const AsMember = query({ path, routes: tab("member") })
/** A viewer sees the projects and no way to create one. */
export const AsViewer = query({ path, routes: tab("viewer") })

export const Empty = query({ path, routes: tab("owner", []) })
export const EmptyAsViewer = query({ path, routes: tab("viewer", []) })

/** The operator suspended the organization: its screens say so above the tabs. */
export const Suspended = query({
  path,
  routes: tab("owner", projects, { suspended: "unpaid invoice" }),
})

// ---- creating a project

const create = "/orgs/org_acme/projects/new"

export const NewProject = mutation({ path: create, routes: tab("member") })

export const NewProjectWithoutAName = mutation({
  path: create,
  routes: tab("member"),
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

export const NewProjectNameTooLong = mutation({
  path: create,
  routes: {
    ...tab("member"),
    "POST /orgs/org_acme/projects": invalid("body.name: must be at most 80 characters"),
  },
  steps: (page) => page.submit({ Name: "The application formerly known as the web app".repeat(2) }),
  shows: ["field-error"],
})

/** The organization has as many projects as the operator allows. */
export const NewProjectOverQuota = mutation({
  path: create,
  routes: {
    ...tab("owner"),
    "POST /orgs/org_acme/projects": quotaExceeded(
      "This organization already has 20 projects",
      "projectsPerOrg",
      20,
    ),
  },
  steps: (page) => page.submit({ Name: "Analytics" }),
  shows: ["form-error"],
})

/** Nothing can be created in a suspended organization: the API says why, in the form. */
export const NewProjectInASuspendedOrganization = mutation({
  path: create,
  routes: {
    ...tab("owner", projects, { suspended: "unpaid invoice" }),
    "POST /orgs/org_acme/projects": suspended("unpaid invoice"),
  },
  steps: (page) => page.submit({ Name: "Analytics" }),
  shows: ["form-error"],
})

export const NewProjectCreating = mutation({
  path: create,
  routes: { ...tab("member"), "POST /orgs/org_acme/projects": PENDING },
  steps: (page) => page.submit({ Name: "Analytics" }),
  shows: ["pending"],
})

const analytics = {
  id: "prj_analytics",
  orgId: "org_acme",
  slug: "analytics",
  name: "Analytics",
  createdAt: "2026-11-10T12:00:00.000Z",
}

export const NewProjectCreated = mutation({
  path: create,
  routes: {
    ...tab("member"),
    "POST /orgs/org_acme/projects": created(analytics, {
      "GET /projects/prj_analytics": ok(analytics),
      "GET /projects/prj_analytics/fleets": ok({ data: [] }),
    }),
  },
  steps: (page) => page.submit({ Name: "Analytics" }),
  shows: ["landed"],
})

/** A viewer opens the address of the form: the page says it is not for them. */
export const NewProjectAsViewer = query({ path: create, routes: { ...tab("viewer") } })
