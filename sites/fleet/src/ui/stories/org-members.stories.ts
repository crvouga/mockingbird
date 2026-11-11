import type { Meta } from "@storybook/html-vite"
import {
  conflict,
  forbidden,
  globex,
  type Invite,
  inOrg,
  invalid,
  invites,
  type Member,
  me,
  members,
  membersWith,
  newInvite,
  notFound,
  quotaExceeded,
  type Role,
  rateLimited,
} from "./fixtures.js"
import { created, type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Organization/Members" } satisfies Meta

const path = "/orgs/org_acme/members"
const admins = (role: Role) => role === "admin" || role === "owner"
const tab = (
  role: Role,
  list: Member[] = role === "owner" ? members : membersWith(role),
  pending: Invite[] = invites,
): MockRoutes => ({
  ...inOrg(role),
  "GET /orgs/org_acme/members": ok({ data: list }),
  ...(admins(role) ? { "GET /orgs/org_acme/invites": ok({ data: pending }) } : {}),
})

/** An owner can change anyone's role, including to and from owner. */
export const AsOwner = query({ path, routes: tab("owner") })
/** An admin can change everyone but owners, and sees the pending invites. */
export const AsAdmin = query({ path, routes: tab("admin") })
/** A member sees who is in the organization and can only leave. */
export const AsMember = query({ path, routes: tab("member") })
export const AsViewer = query({ path, routes: tab("viewer") })
export const NoPendingInvites = query({ path, routes: tab("owner", members, []) })

// ---- changing a role

const linus = "/orgs/org_acme/members/usr_linus"
const withoutLinus = members.filter((member) => member.userId !== "usr_linus")
const linusAs = (role: Role) => ({ ...(members[2] as Member), role })

export const ChangeRole = mutation({ path: `${linus}/role`, routes: tab("owner") })

/** Submitting the role they already have changes nothing: the form says so. */
export const ChangeRoleUnchanged = mutation({
  path: `${linus}/role`,
  routes: tab("owner"),
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

/** The last owner cannot step down: the API's 409 is about the role chosen. */
export const ChangeRoleOfTheLastOwner = mutation({
  path: "/orgs/org_acme/members/usr_ada/role",
  routes: {
    ...tab("owner"),
    "PATCH /orgs/org_acme/members/usr_ada": conflict("An organization needs at least one owner"),
  },
  steps: (page) => page.submit({ Role: "admin" }),
  shows: ["field-error"],
})

export const ChangeRoleSaving = mutation({
  path: `${linus}/role`,
  routes: { ...tab("owner"), "PATCH /orgs/org_acme/members/usr_linus": PENDING },
  steps: (page) => page.submit({ Role: "admin" }),
  shows: ["pending"],
})

/** Back on the list, the change is noted beside the person. */
export const ChangeRoleChanged = mutation({
  path: `${linus}/role`,
  routes: {
    ...tab("owner"),
    "PATCH /orgs/org_acme/members/usr_linus": ok(linusAs("admin"), {
      "GET /orgs/org_acme/members": ok({
        data: members.map((member) => (member.userId === "usr_linus" ? linusAs("admin") : member)),
      }),
    }),
  },
  steps: (page) => page.submit({ Role: "admin" }),
  shows: ["landed"],
})

/** Only an owner may change an owner: an admin opening the address is told so. */
export const ChangeRoleOfAnOwnerAsAdmin = query({
  path: "/orgs/org_acme/members/usr_grace/role",
  routes: tab("admin"),
})

// ---- removing someone

export const Remove = mutation({ path: `${linus}/remove`, routes: tab("admin") })

export const RemoveRefused = mutation({
  path: `${linus}/remove`,
  routes: { ...tab("admin"), "DELETE /orgs/org_acme/members/usr_linus": forbidden },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const Removed = mutation({
  path: `${linus}/remove`,
  routes: {
    ...tab("owner"),
    "DELETE /orgs/org_acme/members/usr_linus": ok(
      { ok: true },
      { "GET /orgs/org_acme/members": ok({ data: withoutLinus }) },
    ),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- leaving

const leave = "/orgs/org_acme/leave"

export const Leave = mutation({ path: leave, routes: tab("member") })

/** The last owner cannot leave. */
export const LeaveAsTheLastOwner = mutation({
  path: leave,
  routes: {
    ...tab("owner"),
    "DELETE /orgs/org_acme/members/usr_ada": conflict("An organization needs at least one owner"),
  },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

/** Gone from the organization, the list of the others says so. */
export const Left = mutation({
  path: leave,
  routes: {
    ...tab("member"),
    "DELETE /orgs/org_acme/members/usr_ada": ok({ ok: true }, { "GET /me": ok(me([globex])) }),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- inviting someone

const invite = "/orgs/org_acme/invites/new"
const { token: _token, acceptUrl: _acceptUrl, ...listedInvite } = newInvite

export const InviteSomeone = mutation({ path: invite, routes: tab("admin") })

export const InviteNotAnEmail = mutation({
  path: invite,
  routes: tab("admin"),
  steps: (page) => page.submit({ Email: "alan" }),
  shows: ["field-error"],
})

export const InviteRejectedEmail = mutation({
  path: invite,
  routes: {
    ...tab("admin"),
    "POST /orgs/org_acme/invites": invalid("body.email: must be at least 3 characters"),
  },
  steps: (page) => page.submit({ Email: "a@" }),
  shows: ["field-error"],
})

/** Members and pending invites together are at the operator's limit. */
export const InviteOverQuota = mutation({
  path: invite,
  routes: {
    ...tab("admin"),
    "POST /orgs/org_acme/invites": quotaExceeded(
      "This organization already has 50 members and pending invites",
      "membersPerOrg",
      50,
    ),
  },
  steps: (page) => page.submit({ Email: "alan@example.com" }),
  shows: ["form-error"],
})

export const InviteCreating = mutation({
  path: invite,
  routes: { ...tab("admin"), "POST /orgs/org_acme/invites": PENDING },
  steps: (page) => page.submit({ Email: "alan@example.com", Role: "admin" }),
  shows: ["pending"],
})

/** The link is shown once, on its own screen, right after the invite is created. */
export const InviteLinkCreated = mutation({
  path: invite,
  routes: {
    ...tab("owner"),
    "POST /orgs/org_acme/invites": created(newInvite, {
      "GET /orgs/org_acme/invites": ok({ data: [...invites, listedInvite] }),
    }),
  },
  steps: (page) => page.submit({ Email: "alan@example.com", Role: "admin" }),
  shows: ["secret"],
})

/** Opened again (a reload, Back, a shared address), the link is gone for good. */
export const InviteLinkShownOnce = query({
  path: "/orgs/org_acme/invites/inv_3/created",
  routes: tab("owner"),
})

// ---- revoking an invite

const revoke = "/orgs/org_acme/invites/inv_1/revoke"

export const RevokeInvite = mutation({ path: revoke, routes: tab("admin") })

/** Someone accepted it a moment ago. */
export const RevokeInviteAlreadyUsed = mutation({
  path: revoke,
  routes: { ...tab("admin"), "DELETE /orgs/org_acme/invites/inv_1": notFound("Invite") },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const InviteRevoked = mutation({
  path: revoke,
  routes: {
    ...tab("admin"),
    "DELETE /orgs/org_acme/invites/inv_1": ok(
      { ok: true },
      { "GET /orgs/org_acme/invites": ok({ data: invites.slice(1) }) },
    ),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- states every mutation is shown in

/** The API throttles the caller: the refusal belongs to no field. */
export const ChangeRoleRateLimited = mutation({
  path: `${linus}/role`,
  routes: { ...tab("owner"), "PATCH /orgs/org_acme/members/usr_linus": rateLimited },
  steps: (page) => page.submit({ Role: "admin" }),
  shows: ["form-error"],
})

export const Removing = mutation({
  path: `${linus}/remove`,
  routes: { ...tab("admin"), "DELETE /orgs/org_acme/members/usr_linus": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

export const Leaving = mutation({
  path: leave,
  routes: { ...tab("member"), "DELETE /orgs/org_acme/members/usr_ada": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

export const RevokingInvite = mutation({
  path: revoke,
  routes: { ...tab("admin"), "DELETE /orgs/org_acme/invites/inv_1": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})
