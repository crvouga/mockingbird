import type { Meta } from "@storybook/html-vite"
import { globex, org, signedIn } from "./fixtures.js"
import { failure, ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Invite" } satisfies Meta

const path = "/invite/k3v9x2m4p7q1w8e5r6t0"

/** Opening an invite link joins the organization and lands on it. */
export const Accepted = story({
  path,
  routes: {
    ...signedIn([org("owner")]),
    "POST /invites/accept": ok(globex, {
      ...signedIn([org("owner"), globex]),
      "GET /orgs/org_globex": ok(globex),
      "GET /orgs/org_globex/projects": ok({ data: [] }),
    }),
  },
})

export const InvalidOrExpired = story({
  path,
  routes: {
    ...signedIn(),
    "POST /invites/accept": failure(
      404,
      "not_found",
      "This invite is invalid, already used or expired",
    ),
  },
})

/** The organization has no room for another member. */
export const Refused = story({
  path,
  routes: {
    ...signedIn(),
    "POST /invites/accept": failure(
      403,
      "quota_exceeded",
      "This organization already has 50 members and pending invites (limit 50). Delete something, or ask the operator to raise membersPerOrg.",
      { limit: "membersPerOrg", max: 50, current: 50 },
    ),
  },
})
