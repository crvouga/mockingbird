import type { Meta } from "@storybook/html-vite"
import { fleets, forbidden, org, project, type Role, signedIn } from "./fixtures.js"
import { failure, ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Project" } satisfies Meta

const path = "/projects/prj_web"
const as = (role: Role, listed = fleets) => ({
  ...signedIn([org(role)]),
  "GET /projects/prj_web": ok(project),
  "GET /orgs/org_acme": ok(org(role)),
  "GET /projects/prj_web/fleets": ok({ data: listed }),
})

/** An owner can delete the project. */
export const WithFleets = story({ path, routes: as("owner") })

export const Empty = story({ path, routes: as("owner", []) })

export const AsAdmin = story({ path, routes: as("admin") })

/** Members and viewers cannot delete the project. */
export const AsMember = story({ path, routes: as("member") })

export const AsViewer = story({ path, routes: as("viewer") })

/** A project key's holder can read the project but not its organization. */
export const OrganizationUnavailable = story({
  path,
  routes: { ...as("member"), "GET /orgs/org_acme": forbidden },
})

/** Fleet slugs are unique across the whole service. */
export const CreateFleetRefused = story({
  path,
  routes: {
    ...as("owner"),
    "POST /projects/prj_web/fleets": failure(
      409,
      "conflict",
      'Fleet slug "staging" is already taken',
    ),
  },
  steps: async (page) => {
    page.type("Fleet name", "Staging")
    page.type("URL slug", "staging")
    await page.press("Create fleet")
  },
  shows: ["flash"],
})
