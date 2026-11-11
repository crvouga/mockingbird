import type { Meta } from "@storybook/html-vite"
import { globex, initech, invalid, org, projects, quotaExceeded, signedIn } from "./fixtures.js"
import { created, type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Organizations" } satisfies Meta

const several = [
  org("owner"),
  globex,
  org("admin", { id: "org_umbrella", slug: "umbrella-labs", name: "Umbrella Labs" }),
]

export const Several = query({ path: "/orgs", routes: signedIn(several) })

export const Empty = query({ path: "/orgs", routes: signedIn([]) })

/** A suspended organization is listed like any other; its own screen says so. */
export const WithASuspendedOne = query({ path: "/orgs", routes: signedIn([...several, initech]) })

/** The bare address opens the first organization instead of the list. */
export const RootOpensTheFirstOrganization = query({
  path: "/",
  routes: {
    ...signedIn(several),
    "GET /orgs/org_acme": ok(org("owner")),
    "GET /orgs/org_acme/projects": ok({ data: projects }),
  },
})

// ---- creating one

const path = "/orgs/new"
const base: MockRoutes = signedIn(several)

export const New = mutation({ path, routes: base })

export const NewWithoutAName = mutation({
  path,
  routes: base,
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

/** The API's 400 names the field: the problem is written under it. */
export const NewNameTooLong = mutation({
  path,
  routes: { ...base, "POST /orgs": invalid("body.name: must be at most 80 characters") },
  steps: (page) => page.submit({ Name: "Acme Corporation ".repeat(5) }),
  shows: ["field-error"],
})

/** One more than the operator allows: a refusal about no field. */
export const NewOverQuota = mutation({
  path,
  routes: {
    ...base,
    "POST /orgs": quotaExceeded("You already own 5 organizations", "orgsPerUser", 5),
  },
  steps: (page) => page.submit({ Name: "One too many" }),
  shows: ["form-error"],
})

export const NewCreating = mutation({
  path,
  routes: { ...base, "POST /orgs": PENDING },
  steps: (page) => page.submit({ Name: "Hooli" }),
  shows: ["pending"],
})

const hooli = org("owner", { id: "org_hooli", slug: "hooli", name: "Hooli" })

/** Created, the dashboard opens it and says so beside its name. */
export const NewCreated = mutation({
  path,
  routes: {
    ...base,
    "POST /orgs": created(hooli, {
      ...signedIn([...several, hooli]),
      "GET /orgs/org_hooli": ok(hooli),
      "GET /orgs/org_hooli/projects": ok({ data: [] }),
    }),
  },
  steps: (page) => page.submit({ Name: "Hooli" }),
  shows: ["landed"],
})
