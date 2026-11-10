import type { Meta } from "@storybook/html-vite"
import { inOrg } from "./fixtures.js"
import { failure } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organization/Settings" } satisfies Meta

const path = "/orgs/org_acme/settings"

/** Only an owner can delete the organization. */
export const AsOwner = story({ path, routes: inOrg("owner") })

export const AsAdmin = story({ path, routes: inOrg("admin") })

export const RenameRefused = story({
  path,
  routes: {
    ...inOrg("owner"),
    "PATCH /orgs/org_acme": failure(
      400,
      "invalid_request",
      "body.name: must be at most 80 characters",
    ),
  },
  steps: async (page) => {
    page.type("Organization name", "Acme ".repeat(20).trim())
    await page.press("Rename")
  },
  shows: ["flash"],
})
