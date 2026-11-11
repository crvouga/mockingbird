import type { Meta } from "@storybook/html-vite"
import { globex, org, quotaExceeded, signedIn } from "./fixtures.js"
import { failure, ok, PENDING } from "./mock.js"
import { mutation } from "./story.js"

export default { title: "Invite" } satisfies Meta

const path = "/invite/k3v9x2m4p7q1w8e5r6t0"

/** Opening the link joins nothing: the screen says what joining means and asks. */
export const Open = mutation({ path, routes: signedIn() })

export const InvalidOrExpired = mutation({
  path,
  routes: {
    ...signedIn(),
    "POST /invites/accept": failure(
      404,
      "not_found",
      "This invite is invalid, already used or expired",
    ),
  },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

/** The organization has no room for another member. */
export const OrganizationFull = mutation({
  path,
  routes: {
    ...signedIn(),
    "POST /invites/accept": quotaExceeded(
      "This organization already has 50 members and pending invites",
      "membersPerOrg",
      50,
    ),
  },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const Joining = mutation({
  path,
  routes: { ...signedIn(), "POST /invites/accept": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

/** Joined, the dashboard opens the organization and says so. */
export const Joined = mutation({
  path,
  routes: {
    ...signedIn([org("owner")]),
    "POST /invites/accept": ok(globex, {
      ...signedIn([org("owner"), globex]),
      "GET /orgs/org_globex": ok(globex),
      "GET /orgs/org_globex/projects": ok({ data: [] }),
    }),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})
