import type { Meta } from "@storybook/html-vite"
import { inOrg, invites, members, membersWith, newInvite } from "./fixtures.js"
import { created, failure, ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organization/Members" } satisfies Meta

const path = "/orgs/org_acme/members"
const none = { "GET /orgs/org_acme/invites": ok({ data: [] }) }

/** An owner can change anyone's role, including to and from owner. */
export const AsOwner = story({
  path,
  routes: { ...inOrg("owner"), "GET /orgs/org_acme/members": ok({ data: members }), ...none },
})

/** An admin can change everyone but owners, and cannot make an owner. */
export const AsAdmin = story({
  path,
  routes: {
    ...inOrg("admin"),
    "GET /orgs/org_acme/members": ok({ data: membersWith("admin") }),
    ...none,
  },
})

/** A member sees the list and can only leave. */
export const AsMember = story({
  path,
  routes: { ...inOrg("member"), "GET /orgs/org_acme/members": ok({ data: membersWith("member") }) },
})

export const AsViewer = story({
  path,
  routes: { ...inOrg("viewer"), "GET /orgs/org_acme/members": ok({ data: membersWith("viewer") }) },
})

export const PendingInvites = story({
  path,
  routes: {
    ...inOrg("owner"),
    "GET /orgs/org_acme/members": ok({ data: members }),
    "GET /orgs/org_acme/invites": ok({ data: invites }),
  },
})

const { token: _token, acceptUrl: _acceptUrl, ...listedInvite } = newInvite

/** The link is shown once, right after the invite is created. */
export const InviteLinkCreated = story({
  path,
  routes: {
    ...inOrg("owner"),
    "GET /orgs/org_acme/members": ok({ data: members }),
    "GET /orgs/org_acme/invites": ok({ data: invites }),
    "POST /orgs/org_acme/invites": created(newInvite, {
      "GET /orgs/org_acme/invites": ok({ data: [...invites, listedInvite] }),
    }),
  },
  steps: async (page) => {
    page.type("Email", "alan@example.com")
    await page.choose("Role", "admin")
    await page.press("Create invite link")
  },
  shows: ["secret:invite"],
})

/** The last owner tries to step down. */
export const RoleChangeRefused = story({
  path,
  routes: {
    ...inOrg("owner"),
    "GET /orgs/org_acme/members": ok({ data: members }),
    ...none,
    "PATCH /orgs/org_acme/members/usr_ada": failure(
      409,
      "conflict",
      "An organization needs at least one owner",
    ),
  },
  steps: (page) => page.choose("Role of ada@example.com", "admin"),
  shows: ["flash"],
})
