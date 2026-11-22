import { Alert, Table } from "@heroui/react"
import { mutation } from "../form.js"
import {
  Aside,
  action,
  Copyable,
  Empty,
  Head,
  JustNow,
  Links,
  Narrow,
  Removed,
  Section,
  Tag,
} from "../kit.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { ApiError, api, day, deny, land, ui } from "../runtime.js"
import { type Invite, type Member, type Org, ROLES } from "../types.js"
import { DangerLink } from "./keys.js"
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
    body: (
      <>
        <section className="flex flex-col gap-4">
          <Removed about={`members:${org.id}`} />
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="Members">
                <Table.Header>
                  <Table.Column isRowHeader>Member</Table.Column>
                  <Table.Column>Role</Table.Column>
                  <Table.Column>
                    <span className="sr-only">Actions</span>
                  </Table.Column>
                </Table.Header>
                <Table.Body>
                  {list.map((member) => {
                    const self = member.userId === me.user?.id
                    const editable = admin && (member.role !== "owner" || org.role === "owner")
                    const who = memberName(member)
                    const at = { org: org.id, user: member.userId }
                    return (
                      <Table.Row key={member.userId} id={member.userId}>
                        <Table.Cell className="whitespace-normal">
                          <span className="flex flex-wrap items-center gap-x-2">
                            <span className="font-medium">{who}</span>
                            {self ? <Aside>you</Aside> : null}
                            <JustNow about={`member:${member.userId}`} />
                          </span>
                          {member.email && member.email !== who ? (
                            <span className="block text-sm break-all text-muted">
                              {member.email}
                            </span>
                          ) : null}
                        </Table.Cell>
                        <Table.Cell>
                          <Tag>{member.role}</Tag>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="flex flex-wrap justify-end gap-x-4 gap-y-1">
                            {editable ? (
                              <a
                                href={to("member.role", at)}
                                aria-label={`Change the role of ${who}`}
                                className="text-sm font-medium text-accent no-underline hover:underline"
                              >
                                Change role
                              </a>
                            ) : null}
                            {self ? (
                              <DangerLink href={to("org.leave", { org: org.id })}>Leave</DangerLink>
                            ) : editable ? (
                              <DangerLink href={to("member.remove", at)} label={`Remove ${who}`}>
                                Remove
                              </DangerLink>
                            ) : null}
                          </span>
                        </Table.Cell>
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </section>
        {admin ? (
          <Section
            title="Pending invites"
            sub="An invite is a link you send yourself; this service sends no email. Whoever opens it and signs in joins with the role you chose."
          >
            <Removed about={`invites:${org.id}`} />
            {invites.length > 0 ? (
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="Pending invites">
                    <Table.Header>
                      <Table.Column isRowHeader>Email</Table.Column>
                      <Table.Column>Role</Table.Column>
                      <Table.Column>
                        <span className="sr-only">Actions</span>
                      </Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {invites.map((invite) => (
                        <Table.Row key={invite.id} id={invite.id}>
                          <Table.Cell className="whitespace-normal">
                            <span className="block font-medium break-all">{invite.email}</span>
                            <span className="block text-sm text-muted">
                              Expires {day(invite.expiresAt)}
                            </span>
                          </Table.Cell>
                          <Table.Cell>
                            <Tag>{invite.role}</Tag>
                          </Table.Cell>
                          <Table.Cell className="text-right">
                            <DangerLink
                              href={to("invite.revoke", { org: org.id, invite: invite.id })}
                              label={`Revoke the invite for ${invite.email}`}
                            >
                              Revoke
                            </DangerLink>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            ) : (
              <Empty title="No invite is waiting to be accepted." />
            )}
          </Section>
        ) : null}
      </>
    ),
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
    crumbs: orgCrumbs(org, { href: back, label: "Members" }, "Change role"),
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
    crumbs: orgCrumbs(org, { href: back, label: "Members" }, "Remove"),
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
    crumbs: orgCrumbs(org, { href: back, label: "Members" }, "Leave"),
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
    crumbs: orgCrumbs(org, { href: back, label: "Members" }, "Invite"),
    lead: "This creates a link for you to send. No email is sent. The link works once, for whoever opens it and signs in, and expires after 7 days.",
    fields: [
      {
        kind: "text",
        type: "email",
        name: "email",
        label: "Email",
        hint: "Who the invite is for. It labels the invite in the list; it does not restrict who can use the link.",
        required: "Enter the email address of the person you are inviting.",
        attrs: { inputMode: "email" },
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
}) {
  if (ui.secret?.id !== spec.id)
    throw new ApiError(
      410,
      `${spec.what} was shown once, right after it was created, and cannot be shown again. If you did not copy it, revoke it and create a new one.`,
    )
  return (
    <Narrow>
      <Head title={spec.title} sub={spec.body} />
      <div data-secret="" className="mb-4">
        <Copyable value={ui.secret.value} />
      </div>
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <p className="text-sm">
            <strong>It will not be shown again.</strong> Copy it now: leaving this screen loses it.
          </p>
        </Alert.Content>
      </Alert>
      <Links>{action(spec.done, "Done", "primary")}</Links>
    </Narrow>
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
    crumbs: orgCrumbs(org, { href: back, label: "Members" }, "Revoke invite"),
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
