import { h } from "../dom.js"
import { act, api, confirmThen, day, field, form, secretNotice, ui } from "../runtime.js"
import type { Key, Org, Project } from "../types.js"

export function keyList(
  label: string,
  list: Key[],
  revoke: (key: Key) => Promise<unknown>,
  empty: string,
) {
  return list.length > 0
    ? h(
        ".list",
        { role: "list", "aria-label": label },
        list.map((key) =>
          h(
            ".row",
            { role: "listitem" },
            h(
              ".grow",
              {},
              h(".title", {}, key.name),
              h(
                ".meta.mono.wrap",
                {},
                `${key.prefix}… · last used ${day(key.lastUsedAt)}${key.expiresAt ? ` · expires ${day(key.expiresAt)}` : ""}`,
              ),
            ),
            key.role && h("span.tag", {}, key.projectId ? `project ${key.role}` : key.role),
            h(
              "button.small.danger",
              {
                type: "button",
                onclick: confirmThen(`Revoke ${key.name}? Anything using it stops working.`, () =>
                  revoke(key),
                ),
              },
              "Revoke",
            ),
          ),
        ),
      )
    : h(".empty", {}, empty)
}

export async function keys(org: Org) {
  const [list, projects] = await Promise.all([
    api<{ data: Key[] }>("GET", `/orgs/${org.id}/api-keys`),
    api<{ data: Project[] }>("GET", `/orgs/${org.id}/projects`),
  ])
  return h(
    "section",
    {},
    h(
      "p.sub",
      {},
      "Keys let CI and agents call the API and protected fleets. An organization key reaches every project; a project key reaches one.",
    ),
    secretNotice(),
    h(
      "form.inline.newkey",
      {
        onsubmit: act(async () => {
          const projectId = field(form("form.newkey"), "projectId")
          const key = await api<Key>("POST", `/orgs/${org.id}/api-keys`, {
            name: field(form("form.newkey"), "name"),
            role: field(form("form.newkey"), "role"),
            ...(projectId ? { projectId } : {}),
          })
          ui.revealed = { label: "API key created.", value: key.key ?? "" }
        }),
      },
      h("input", {
        name: "name",
        required: true,
        maxlength: "80",
        placeholder: "Key name, e.g. ci",
        "aria-label": "Key name",
      }),
      h(
        "select",
        { name: "projectId", "aria-label": "Scope" },
        h("option", { value: "" }, "Whole organization"),
        projects.data.map((project) =>
          h("option", { value: project.id }, `Project: ${project.name}`),
        ),
      ),
      h(
        "select",
        { name: "role", "aria-label": "Role" },
        ["member", "viewer", "admin"].map((role) => h("option", { value: role }, role)),
      ),
      h("button.primary", {}, "Create key"),
    ),
    keyList(
      "API keys",
      list.data,
      (key) => api("DELETE", `/orgs/${org.id}/api-keys/${key.id}`),
      "No API keys yet.",
    ),
  )
}
