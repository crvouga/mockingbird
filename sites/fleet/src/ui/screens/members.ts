import { h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import {
  ApiError,
  action,
  api,
  copyable,
  day,
  deny,
  justNow,
  land,
  link,
  removed,
  section,
  ui,
} from "../runtime.js"
import { type Invite, type Member, type Org, ROLES } from "../types.js"
import { orgCrumbs, orgFor, type TabContext } from "./org.js"

/** What each role may do, as the role choices describe it. */
export const ROLE_ABOUT: Record<(typeof ROLES)[number], string> = {
  viewer: "Can look at projects, fleets and usage. Cannot change anything.",
  member: "Can create and change projects, fleets and emulators.",
  admin: "Everything a member can, plus members, invites, API keys, the audit log and settings.",
  owner: "Everything an admin can, plus changing owners and deleting the organization.",
}

const roleOptions = (roles: readonly string[]) =>
  roles.map((role) => ({
    value: role,
    label: role.charAt(0).toUpperCase() + role.slice(1),
    description: ROLE_ABOUT[role as keyof typeof ROLE_ABOUT],
  }))

/** How a member is named: their name, else their email, else their id. */
export const memberName = (member: Member) => member.name ?? member.email ?? member.userId

const listMembers = async (org: Org) =>
  (await api<{ data: Member[] }>("GET", `/orgs/${org.id}/members`)).data
const listInvites = async (org: Org) =>
  (await api<{ data: Invite[] }>("GET", `/orgs/${org.id}/invites`)).data

export async function members({ me, org, admin }: TabContext) {
  const [list, invites] = await Promise.all([listMembers(org), admin ? listInvites(org) : []])
  return {
    action: admin && action(to("invite.new", { org: org.id }), "Invite someone", "primary"),
    body: [
      h(
        "section",
        {},
        removed(`members:${org.id}`),
        h(
          ".list",
          { role: "list", "aria-label": "Members" },
          list.map((member) => {
            const self = member.userId === me.user?.id
            const editable = admin && (member.role !== "owner" || org.role === "owner")
            const who = memberName(member)
            const at = { org: org.id, user: member.userId }
            return h(
              ".row",
              { role: "listitem" },
              h(
                ".grow",
                {},
                h(".title", {}, who, self && h("span.aside", {}, "you")),
                member.email && member.email !== who && h(".meta", {}, member.email),
              ),
              justNow(`member:${member.userId}`),
              h("span.tag", {}, member.role),
              (editable || self) &&
                h(
                  ".row-links",
                  {},
                  editable &&
                    link(
                      to("member.role", at),
                      { "aria-label": `Change the role of ${who}` },
                      "Change role",
                    ),
                  self
                    ? link(to("org.leave", { org: org.id }), { class: "danger" }, "Leave")
                    : editable &&
                        link(
                          to("member.remove", at),
                          { class: "danger", "aria-label": `Remove ${who}` },
                          "Remove",
                        ),
                ),
            )
          }),
        ),
      ),
      admin &&
        section(
          "Pending invites",
          null,
          h(
            "p.sub",
            {},
            "An invite is a link you send yourself; this service sends no email. Whoever opens it and signs in joins with the role you chose.",
          ),
          removed(`invites:${org.id}`),
          invites.length > 0
            ? h(
                ".list",
                { role: "list", "aria-label": "Pending invites" },
                invites.map((invite) =>
                  h(
                    ".row",
                    { role: "listitem" },
                    h(
                      ".grow",
                      {},
                      h(".title", {}, invite.email),
                      h(".meta", {}, `Expires ${day(invite.expiresAt)}`),
                    ),
                    h("span.tag", {}, invite.role),
                    h(
                      ".row-links",
                      {},
                      link(
                        to("invite.revoke", { org: org.id, invite: invite.id }),
                        { class: "danger", "aria-label": `Revoke the invite for ${invite.email}` },
                        "Revoke",
                      ),
                    ),
                  ),
                ),
              )
            : h(".empty", {}, "No invite is waiting to be accepted."),
        ),
    ],
  }
}

/** The member a mutation acts on; the API has no call for one member, so it is found in the list. */
async function memberFor(org: Org, userId: string) {
  const member = (await listMembers(org)).find((entry) => entry.userId === userId)
  if (!member) throw new ApiError(404, "This person is not a member of the organization.")
  if (member.role === "owner" && org.role !== "owner")
    deny(`Only an owner can change or remove an owner of ${org.name}.`)
  return member
}

export async function memberRole({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Changing roles")
  const member = await memberFor(org, params.user ?? "")
  const back = to("org.members", { org: org.id })
  const who = memberName(member)
  return mutation({
    title: titleOf(route, { member: who }),
    crumbs: orgCrumbs(org, link(back, {}, "Members"), "Change role"),
    lead: `${who} is ${member.role === "owner" || member.role === "admin" ? "an" : "a"} ${member.role} of ${org.name}. The new role applies to their next request.`,
    fields: [
      {
        kind: "choice",
        name: "role",
        label: "Role",
        value: member.role,
        // Only an owner can make an owner.
        options: roleOptions(ROLES.filter((role) => role !== "owner" || org.role === "owner")),
      },
    ],
    check: ({ role }) =>
      role === member.role ? { role: `${who} already has this role. Choose a different one.` } : {},
    place: (error) => (error.status === 409 ? "role" : undefined),
    submit: "Change role",
    pending: "Changing…",
    cancel: back,
    failed: "The role was not changed.",
    run: async ({ role }) => {
      await api("PATCH", `/orgs/${org.id}/members/${member.userId}`, { role })
      await land(back, {
        note: { about: `member:${member.userId}`, text: "Role changed just now" },
      })
    },
  })
}

export async function memberRemove({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Removing members")
  const member = await memberFor(org, params.user ?? "")
  const back = to("org.members", { org: org.id })
  const who = memberName(member)
  return mutation({
    title: titleOf(route, { member: who, organization: org.name }),
    crumbs: orgCrumbs(org, link(back, {}, "Members"), "Remove"),
    danger: true,
    lead: `${who} loses access to every project and fleet of ${org.name} at once. API keys they created keep working until you revoke them. You can invite them again later.`,
    submit: "Remove member",
    pending: "Removing…",
    cancel: back,
    failed: "The member was not removed.",
    run: async () => {
      await api("DELETE", `/orgs/${org.id}/members/${member.userId}`)
      await land(back, {
        note: { about: `members:${org.id}`, text: `${who} was removed just now.` },
      })
    },
  })
}

export async function orgLeave({ me, route, params }: Context) {
  const org = await orgFor(params.org ?? "", "viewer", "Leaving")
  const back = to("org.members", { org: org.id })
  return mutation({
    title: titleOf(route, { organization: org.name }),
    crumbs: orgCrumbs(org, link(back, {}, "Members"), "Leave"),
    danger: true,
    lead: `You lose access to every project and fleet of ${org.name}. To come back, an admin has to invite you again. An organization's last owner cannot leave.`,
    submit: "Leave organization",
    pending: "Leaving…",
    cancel: back,
    failed: "You are still a member.",
    run: async () => {
      await api("DELETE", `/orgs/${org.id}/members/${me.user?.id ?? ""}`)
      await land(to("orgs"), { note: { about: "orgs", text: `You left ${org.name} just now.` } })
    },
  })
}

export async function inviteNew({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Inviting people")
  const back = to("org.members", { org: org.id })
  return mutation({
    title: titleOf(route, { organization: org.name }),
    crumbs: orgCrumbs(org, link(back, {}, "Members"), "Invite"),
    lead: "This creates a link for you to send. No email is sent. The link works once, for whoever opens it and signs in, and expires after 7 days.",
    fields: [
      {
        kind: "text",
        type: "email",
        name: "email",
        label: "Email",
        hint: "Who the invite is for. It labels the invite in the list; it does not restrict who can use the link.",
        required: "Enter the email address of the person you are inviting.",
        attrs: { inputmode: "email" },
      },
      {
        kind: "choice",
        name: "role",
        label: "Role",
        value: "member",
        options: roleOptions(["viewer", "member", "admin"]),
      },
    ],
    check: ({ email }) =>
      email && !/^[^@\s]+@[^@\s]+$/.test(email)
        ? { email: "Enter an email address with an @, like teammate@example.com." }
        : {},
    submit: "Create invite link",
    pending: "Creating…",
    cancel: back,
    failed: "The invite was not created.",
    run: async ({ email, role }) => {
      const invite = await api<Invite>("POST", `/orgs/${org.id}/invites`, { email, role })
      await land(to("invite.created", { org: org.id, invite: invite.id }), {
        secret: { id: invite.id, value: invite.acceptUrl ?? "", for: invite.email },
      })
    },
  })
}

/**
 * The screen a secret is shown on, once: the value, a way to copy it, and the way out. Opened any
 * other way (a reload, Back, a shared link) there is nothing left to show.
 */
export function secretScreen(spec: {
  id: string
  title: string
  what: string
  body: string
  done: string
  crumbs?: unknown
}) {
  if (ui.secret?.id !== spec.id)
    throw new ApiError(
      410,
      `${spec.what} was shown once, right after it was created, and cannot be shown again. If you did not copy it, revoke it and create a new one.`,
    )
  return h(
    ".result",
    {},
    h("h1", { tabindex: "-1" }, spec.title),
    h("p.lead", {}, spec.body),
    h(".secret", {}, copyable(ui.secret.value)),
    h(
      "p.notice.warn",
      {},
      h("strong", {}, "It will not be shown again."),
      " Copy it now: leaving this screen loses it.",
    ),
    h("p.form-actions", {}, action(spec.done, "Done", "primary")),
  )
}

export async function inviteCreated({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Inviting people")
  return secretScreen({
    id: params.invite ?? "",
    title: route.title,
    what: "This invite link",
    body: `Send this link to ${ui.secret?.for ?? "the person you invited"}. Opening it and signing in adds them to ${org.name}.`,
    done: to("org.members", { org: org.id }),
  })
}

export async function inviteRevoke({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Revoking invites")
  const invite = (await listInvites(org)).find((entry) => entry.id === params.invite)
  if (!invite)
    throw new ApiError(404, "This invite does not exist, or was already used or revoked.")
  const back = to("org.members", { org: org.id })
  return mutation({
    title: titleOf(route, { email: invite.email }),
    crumbs: orgCrumbs(org, link(back, {}, "Members"), "Revoke invite"),
    danger: true,
    lead: `The link sent to ${invite.email} stops working. Anyone who already joined with it stays a member.`,
    submit: "Revoke invite",
    pending: "Revoking…",
    cancel: back,
    failed: "The invite was not revoked.",
    run: async () => {
      await api("DELETE", `/orgs/${org.id}/invites/${invite.id}`)
      await land(back, {
        note: {
          about: `invites:${org.id}`,
          text: `The invite for ${invite.email} was revoked just now.`,
        },
      })
    },
  })
}
