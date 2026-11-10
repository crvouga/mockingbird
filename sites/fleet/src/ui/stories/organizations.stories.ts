import type { Meta } from "@storybook/html-vite"
import { globex, initech, org, projects, quotaExceeded, signedIn } from "./fixtures.js"
import { ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organizations" } satisfies Meta

const several = [
  org("owner"),
  globex,
  org("admin", { id: "org_umbrella", slug: "umbrella-labs", name: "Umbrella Labs" }),
]

export const Several = story({ path: "/orgs", routes: signedIn(several) })

export const Empty = story({ path: "/orgs", routes: signedIn([]) })

/** A suspended organization is listed like any other; its own screen says so. */
export const WithASuspendedOne = story({ path: "/orgs", routes: signedIn([...several, initech]) })

/** The bare address opens the first organization instead of the list. */
export const RootOpensTheFirstOrganization = story({
  path: "/",
  routes: {
    ...signedIn(several),
    "GET /orgs/org_acme": ok(org("owner")),
    "GET /orgs/org_acme/projects": ok({ data: projects }),
  },
})

/** Creating one more than the operator allows. */
export const CreateRefused = story({
  path: "/orgs",
  routes: {
    ...signedIn(several),
    "POST /orgs": quotaExceeded("You already own 5 organizations", "orgsPerUser", 5),
  },
  steps: async (page) => {
    page.type("Organization name", "One too many")
    await page.press("Create organization")
  },
  shows: ["flash"],
})
