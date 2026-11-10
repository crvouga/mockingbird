import { type Child, h } from "../dom.js"
import { ORG_TABS, type OrgTabId, orgTab } from "../routes.js"
import {
  act,
  api,
  confirmThen,
  crumbs,
  field,
  flash,
  flashSlot,
  form,
  link,
  navigate,
  noAccess,
  ui,
} from "../runtime.js"
import type { Me, Org, Project } from "../types.js"
import { auditLog } from "./audit.js"
import { keys } from "./keys.js"
import { members } from "./members.js"
import { usage } from "./usage.js"

type TabContext = { me: Me; org: Org; orgId: string; admin: boolean }

/** What each tab shows under the organization's header. */
const TAB_BODY: Record<OrgTabId, (context: TabContext) => Promise<Child>> = {
  projects: ({ org, orgId }) => projects(org, orgId),
  members: ({ me, org, admin }) => members(me, org, admin),
  usage: ({ org }) => usage(org),
  keys: ({ org }) => keys(org),
  audit: ({ org }) => auditLog(org),
  settings: async ({ org, orgId }) => settings(org, orgId),
}

export async function orgScreen(me: Me, orgId: string, tab: string) {
  const org = await api<Org>("GET", `/orgs/${orgId}`)
  const admin = ["admin", "owner"].includes(org.role ?? "")
  const current = orgTab(tab)
  const header = [
    crumbs(link("/orgs", {}, "Organizations"), org.name),
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, org.name),
        h(
          "p.sub",
          {},
          `You are ${org.role === "owner" || org.role === "admin" ? "an" : "a"} ${org.role} of this organization.`,
        ),
      ),
    ),
    h(
      "nav.tabs",
      { "aria-label": "Organization" },
      ORG_TABS.filter((entry) => admin || !entry.admin).map(({ id, label }) =>
        link(
          `/orgs/${orgId}${id === "projects" ? "" : `/${id}`}`,
          current === id ? { "aria-current": "page" } : {},
          label,
        ),
      ),
    ),
  ]
  if (org.suspended)
    header.push(
      h(
        "p.notice.error",
        { role: "alert" },
        `This organization is suspended: ${org.suspended}. Its fleets do not serve requests and nothing can be created or changed.`,
      ),
    )
  header.push(flashSlot())
  const shown = ORG_TABS.find((entry) => entry.id === current)
  // The API refuses these tabs' calls for anyone below admin; say so instead of asking.
  if (shown?.admin && !admin)
    return [
      header,
      noAccess(
        `${shown.label} is for admins and owners of this organization. You are a ${org.role}.`,
      ),
    ]
  return [header, await TAB_BODY[current]({ me, org, orgId, admin })]
}

function settings(org: Org, orgId: string) {
  return [
    h(
      "section",
      {},
      h("h2", {}, "Name"),
      h(
        "form.inline",
        { onsubmit: act(() => api("PATCH", `/orgs/${orgId}`, { name: field(form(), "name") })) },
        h("input", {
          name: "name",
          required: true,
          value: org.name,
          "aria-label": "Organization name",
        }),
        h("button", {}, "Rename"),
      ),
    ),
    org.role === "owner" &&
      h(
        "section",
        {},
        h("h2", {}, "Delete organization"),
        h(
          "p.sub",
          {},
          "Deletes every project, fleet, API key and all stored emulator state. This cannot be undone.",
        ),
        h(
          "form.inline",
          {},
          h(
            "button.danger",
            {
              type: "button",
              onclick: confirmThen(
                `Delete ${org.name} and everything in it?`,
                () => api("DELETE", `/orgs/${orgId}`),
                () => ui.address.replace("/orgs"),
              ),
            },
            "Delete organization",
          ),
        ),
      ),
  ]
}

async function projects(org: Org, orgId: string) {
  const list = (await api<{ data: Project[] }>("GET", `/orgs/${orgId}/projects`)).data
  return [
    list.length > 0
      ? h(
          "nav.list",
          { "aria-label": "Projects" },
          list.map((project) =>
            link(
              `/projects/${project.id}`,
              { class: "row" },
              h(".grow", {}, h(".title", {}, project.name), h(".meta", {}, project.slug)),
            ),
          ),
        )
      : h(
          ".empty",
          {},
          h("strong", {}, "No projects yet"),
          "A project groups the fleets of one application.",
        ),
    org.role !== "viewer" &&
      h(
        "form.inline",
        {
          onsubmit: async (event) => {
            event.preventDefault()
            try {
              const project = await api<Project>("POST", `/orgs/${orgId}/projects`, {
                name: field(event.target as HTMLFormElement, "name"),
              })
              navigate(undefined, `/projects/${project.id}`)
            } catch (error) {
              flash((error as Error).message)
            }
          },
        },
        h("input", {
          name: "name",
          required: true,
          maxlength: "80",
          placeholder: "Project name",
          "aria-label": "Project name",
        }),
        h("button.primary", {}, "Create project"),
      ),
  ]
}
