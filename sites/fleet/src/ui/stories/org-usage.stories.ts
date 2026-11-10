import type { Meta } from "@storybook/html-vite"
import { inOrg, limits, usage } from "./fixtures.js"
import { ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organization/Usage" } satisfies Meta

const path = "/orgs/org_acme/usage"

export const Normal = story({
  path,
  routes: { ...inOrg("owner"), "GET /orgs/org_acme/usage": ok(usage()) },
})

/** Quotas that are used up are marked: here projects and the month's requests. */
export const QuotaAtItsLimit = story({
  path,
  routes: {
    ...inOrg("owner"),
    "GET /orgs/org_acme/usage": ok(
      usage({
        usage: { projects: 20, fleets: 49, members: 7, apiKeys: 5, requestsThisMonth: 1_000_000 },
      }),
    ),
  },
})

/** The operator set every limit to 0, which means unlimited. */
export const Unlimited = story({
  path,
  routes: {
    ...inOrg("owner"),
    "GET /orgs/org_acme/usage": ok(
      usage({
        limits: Object.fromEntries(Object.keys(limits).map((name) => [name, 0])) as typeof limits,
      }),
    ),
  },
})

export const NoRequestsYet = story({
  path,
  routes: {
    ...inOrg("owner"),
    "GET /orgs/org_acme/usage": ok(
      usage({
        usage: { projects: 1, fleets: 0, members: 1, apiKeys: 0, requestsThisMonth: 0 },
        daily: [],
      }),
    ),
  },
})

export const AsAdmin = story({
  path,
  routes: { ...inOrg("admin"), "GET /orgs/org_acme/usage": ok(usage()) },
})

export const AsMember = story({
  path,
  routes: { ...inOrg("member"), "GET /orgs/org_acme/usage": ok(usage()) },
})

/** Everyone in the organization can read its usage. */
export const AsViewer = story({
  path,
  routes: { ...inOrg("viewer"), "GET /orgs/org_acme/usage": ok(usage()) },
})
