import type { Meta } from "@storybook/html-vite"
import { inOrg, limits, type Role, usage } from "./fixtures.js"
import { type MockRoutes, ok } from "./mock.js"
import { query } from "./story.js"

export default { title: "Organization/Usage" } satisfies Meta

const path = "/orgs/org_acme/usage"
const tab = (role: Role, report = usage()): MockRoutes => ({
  ...inOrg(role),
  "GET /orgs/org_acme/usage": ok(report),
})

export const AsOwner = query({ path, routes: tab("owner") })
export const AsAdmin = query({ path, routes: tab("admin") })
export const AsMember = query({ path, routes: tab("member") })
/** Everyone in the organization can read its usage. */
export const AsViewer = query({ path, routes: tab("viewer") })

/** Quotas that are used up are marked: here projects and the month's requests. */
export const AtTheLimit = query({
  path,
  routes: tab(
    "owner",
    usage({
      usage: { projects: 20, fleets: 49, members: 7, apiKeys: 5, requestsThisMonth: 1_000_000 },
    }),
  ),
})

/** The operator set every limit to 0, which means unlimited. */
export const Unlimited = query({
  path,
  routes: tab(
    "owner",
    usage({
      limits: Object.fromEntries(Object.keys(limits).map((name) => [name, 0])) as typeof limits,
    }),
  ),
})

export const NoRequestsYet = query({
  path,
  routes: tab(
    "owner",
    usage({
      usage: { projects: 1, fleets: 0, members: 1, apiKeys: 0, requestsThisMonth: 0 },
      daily: [],
    }),
  ),
})
