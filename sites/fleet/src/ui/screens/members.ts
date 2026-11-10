import { h } from "../dom.js"
import { act, api, confirmThen, day, field, form, secretNotice, ui } from "../runtime.js"
import { type Me, type Org, ROLES } from "../types.js"

export async function members(me: Me, org: Org, admin: boolean) {
  const list = (
    await api<{
      data: { userId: string; email: string | null; name: string | null; role: string }[]
    }>("GET", `/orgs/${org.id}/members`)
  ).data
  const invites = admin
    ? (
        await api<{
          data: {
            id: string
            email: string
            role: string
            expiresAt: string
          }[]
        }>("GET", `/orgs/${org.id}/invites`)
      ).data
    : []
  const roles = ROLES.filter((role) => role !== "owner" || org.role === "owner")
  return [
    h(
      "section",
      {},
      h(
        ".list",
        { role: "list", "aria-label": "Members" },
        list.map((member) => {
          const self = member.email !== null && member.email === me.user?.email
          const editable = admin && (member.role !== "owner" || org.role === "owner")
          return h(
            ".row",
            { role: "listitem" },
            h(
              ".grow",
              {},
              h(".title", {}, member.name ?? member.email ?? member.userId, self && " (you)"),
              h(".meta", {}, member.email ?? ""),
            ),
            editable
              ? h(
                  "select",
                  {
                    "aria-label": `Role of ${member.email ?? member.userId}`,
                    onchange: (event) =>
                      void act(() =>
                        api("PATCH", `/orgs/${org.id}/members/${member.userId}`, {
                          role: (event.target as HTMLSelectElement).value,
                        }),
                      )(event),
                  },
                  roles.map((role) =>
                    h("option", { value: role, selected: role === member.role }, role),
                  ),
                )
              : h("span.tag", {}, member.role),
            (editable || self) &&
              h(
                "button.small.danger",
                {
                  type: "button",
                  onclick: confirmThen(
                    self ? `Leave ${org.name}?` : `Remove ${member.email ?? "this member"}?`,
                    () => api("DELETE", `/orgs/${org.id}/members/${member.userId}`),
                    () => self && ui.address.replace("/orgs"),
                  ),
                },
                self ? "Leave" : "Remove",
              ),
          )
        }),
      ),
    ),
    admin &&
      h(
        "section",
        {},
        h("h2", {}, "Invite someone"),
        h(
          "p.sub",
          {},
          "Creating an invite gives you a link to send. Whoever opens it and signs in joins with the role you chose.",
        ),
        secretNotice(),
        h(
          "form.inline",
          {
            onsubmit: act(async () => {
              const invite = await api<{ acceptUrl: string }>("POST", `/orgs/${org.id}/invites`, {
                email: field(form("form.invite"), "email"),
                role: field(form("form.invite"), "role"),
              })
              ui.revealed = { label: "Invite link created.", value: invite.acceptUrl }
            }),
            class: "inline invite",
          },
          h("input", {
            name: "email",
            type: "email",
            required: true,
            placeholder: "teammate@example.com",
            "aria-label": "Email",
          }),
          h(
            "select",
            { name: "role", "aria-label": "Role" },
            ["member", "viewer", "admin"].map((role) => h("option", { value: role }, role)),
          ),
          h("button.primary", {}, "Create invite link"),
        ),
        invites.length > 0 &&
          h(
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
                  h(".meta", {}, `${invite.role} · expires ${day(invite.expiresAt)}`),
                ),
                h(
                  "button.small.danger",
                  {
                    type: "button",
                    onclick: act(() => api("DELETE", `/orgs/${org.id}/invites/${invite.id}`)),
                  },
                  "Revoke",
                ),
              ),
            ),
          ),
      ),
  ]
}
