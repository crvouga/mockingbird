import type { Meta } from "@storybook/html-vite"
import { audit, inOrg } from "./fixtures.js"
import { ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organization/Audit log" } satisfies Meta

const path = "/orgs/org_acme/audit"

/** Changes made by people, by API keys and by the operator. */
export const Populated = story({
  path,
  routes: { ...inOrg("owner"), "GET /orgs/org_acme/audit": ok({ data: audit }) },
})

export const Empty = story({
  path,
  routes: { ...inOrg("admin"), "GET /orgs/org_acme/audit": ok({ data: [] }) },
})
