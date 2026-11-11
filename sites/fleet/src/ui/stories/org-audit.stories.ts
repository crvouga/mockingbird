import type { Meta } from "@storybook/html-vite"
import { audit, inOrg, type Role } from "./fixtures.js"
import { type MockRoutes, ok } from "./mock.js"
import { query } from "./story.js"

export default { title: "Organization/Audit log" } satisfies Meta

const path = "/orgs/org_acme/audit"
const tab = (role: Role, entries = audit): MockRoutes => ({
  ...inOrg(role),
  "GET /orgs/org_acme/audit": ok({ data: entries }),
})

/** Changes by people, keys and the operator, newest first. */
export const AsOwner = query({ path, routes: tab("owner") })
export const AsAdmin = query({ path, routes: tab("admin") })
export const Empty = query({ path, routes: tab("owner", []) })

/** The log is for admins: anyone else is told so, and the API is not asked. */
export const AsMember = query({ path, routes: inOrg("member") })
export const AsViewer = query({ path, routes: inOrg("viewer") })
