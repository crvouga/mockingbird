import { type Child, h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { ORG_TABS, type OrgTabId, titleOf, to } from "../routes.js"
import {
  action,
  api,
  aRole,
  atLeast,
  crumbs,
  declared,
  declareIt,
  deny,
  head,
  justNow,
  land,
  link,
  managedNotice,
  properties,
  removed,
  section,
} from "../runtime.js"
import type { Me, Org, Project } from "../types.js"
import { auditLog } from "./audit.js"
import { configuration } from "./configuration.js"
import { keys } from "./keys.js"
import { members } from "./members.js"
import { usage } from "./usage.js"

export type TabContext = { me: Me; org: Org; admin: boolean }
/** A tab's content and the one action the organization's header offers while it is shown. */
type Tab = { action?: Child; body: Child }

const TAB_BODY: Record<OrgTabId, (context: TabContext) => Promise<Tab> | Tab> = {
  projects,
  configuration,
  members,
  usage: async ({ org }) => ({ body: await usage(org) }),
  keys,
  audit: async ({ org }) => ({ body: await auditLog(org) }),
  settings,
}

/** The organization's breadcrumb, for its own screens and the mutations opened from them. */
export const orgCrumbs = (org: Org, ...rest: Child[]) =>
  crumbs(
    link(to("orgs"), {}, "Organizations"),
    rest.length > 0 ? link(to("org", { org: org.id }), {}, org.name) : org.name,
    ...rest,
  )

/** Read the organization a mutation acts on, refusing anyone below `minimum`. */
export async function orgFor(orgId: string, minimum: string, what: string): Promise<Org> {
  const org = await api<Org>("GET", `/orgs/${orgId}`)
  if (!atLeast(org.role, minimum))
    deny(
      `${what} is for ${minimum === "owner" ? "owners" : `${minimum}s and above`} of ${org.name}. You are ${aRole(org.role)}.`,
    )
  return org
}

export async function orgScreen({ me, route, params }: Context) {
  const org = await api<Org>("GET", `/orgs/${params.org}`)
  const admin = atLeast(org.role, "admin")
  const shown = ORG_TABS.find((tab) => tab.route === route.id) ?? ORG_TABS[0]
  // The API refuses these tabs' calls for anyone below admin; say so instead of asking.
  if (shown.admin && !admin)
    deny(`${shown.label} is for admins and owners of ${org.name}. You are ${aRole(org.role)}.`)
  const tab = await TAB_BODY[shown.id]({ me, org, admin })
  return [
    orgCrumbs(org),
    head(
      org.name,
      [`You are ${aRole(org.role)} of this organization.`, justNow(`org:${org.id}`)],
      tab.action,
    ),
    org.suspended &&
      h(
        "p.notice.warn",
        {},
        h("strong", {}, `This organization is suspended: ${org.suspended}.`),
        " Its fleets do not serve requests, and nothing can be created or changed until the operator of this server lifts the suspension. You can still look and delete.",
      ),
    h(
      "nav.tabs",
      { "aria-label": "Organization" },
      ORG_TABS.filter((entry) => admin || !entry.admin).map((entry) =>
        link(
          to(entry.route, { org: org.id }),
          shown.id === entry.id ? { "aria-current": "page" } : {},
          entry.label,
        ),
      ),
    ),
    tab.body,
  ]
}

async function projects({ org }: TabContext): Promise<Tab> {
  const list = (await api<{ data: Project[] }>("GET", `/orgs/${org.id}/projects`)).data
  const canCreate = !org.managed && atLeast(org.role, "member")
  return {
    // In an empty organization the file is the first step; creating by hand stays on offer.
    action:
      canCreate &&
      action(
        to("project.new", { org: org.id }),
        "New project",
        list.length > 0 ? "primary" : "plain",
      ),
    body: [
      managedNotice(
        org,
        "This organization's projects, fleets and emulators are declared in the file, so they are read-only here.",
      ),
      removed(`projects:${org.id}`),
      list.length > 0
        ? h(
            "nav.list",
            { "aria-label": "Projects" },
            list.map((project) =>
              link(
                to("project", { project: project.id }),
                { class: "row" },
                h(".grow", {}, h(".title", {}, project.name), h(".meta", {}, project.slug)),
                h("span.chevron", { "aria-hidden": "true" }, "›"),
              ),
            ),
          )
        : h(
            ".empty",
            {},
            h("strong", {}, "No projects yet"),
            org.managed
              ? "The file declares no projects. Add one to it and apply it."
              : canCreate
                ? [
                    declareIt(org.id, "this organization's projects, fleets and emulators"),
                    h(
                      "p.empty-aside",
                      {},
                      "A project groups the fleets of one application. Create the first one.",
                    ),
                  ]
                : "A project groups the fleets of one application. A member of the organization can create one.",
          ),
    ],
  }
}

function settings({ org }: TabContext): Tab {
  return {
    body: [
      managedNotice(
        org,
        "The organization's name is declared in the file, so it is read-only here.",
      ),
      properties("Organization settings", [
        {
          name: "Name",
          value: org.name,
          about: `org-name:${org.id}`,
          change:
            !org.managed &&
            link(
              to("org.rename", { org: org.id }),
              { "aria-label": "Rename the organization" },
              "Rename",
            ),
        },
        { name: "Slug", value: [h("code", {}, org.slug), h("span.aside", {}, "Permanent")] },
        { name: "ID", value: h("code", {}, org.id) },
      ]),
      org.role === "owner" &&
        section(
          "Delete this organization",
          null,
          h(
            "p.sub",
            {},
            "Deletes every project, fleet, API key and all stored emulator state. This cannot be undone.",
          ),
          h("p", {}, action(to("org.delete", { org: org.id }), "Delete organization…", "danger")),
        ),
    ],
  }
}

export async function orgRename({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Renaming the organization")
  const back = to("org.settings", { org: org.id })
  declared(org, "Renaming the organization", { href: back, label: "Back to Settings" })
  return mutation({
    title: titleOf(route, { organization: org.name }),
    crumbs: orgCrumbs(org, link(back, {}, "Settings"), "Rename"),
    lead: "The name is what members see. The slug and every fleet URL stay the same.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        value: org.name,
        hint: "Up to 80 characters.",
        required: "Enter a name for the organization.",
        attrs: { maxlength: "80" },
      },
    ],
    submit: "Rename organization",
    pending: "Renaming…",
    cancel: back,
    failed: "The organization was not renamed.",
    run: async ({ name }) => {
      await api("PATCH", `/orgs/${org.id}`, { name })
      await land(back, { note: { about: `org-name:${org.id}`, text: "Renamed just now" } })
    },
  })
}

export async function orgDelete({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "owner", "Deleting the organization")
  const back = to("org.settings", { org: org.id })
  return mutation({
    title: titleOf(route, { organization: org.name }),
    crumbs: orgCrumbs(org, link(back, {}, "Settings"), "Delete"),
    danger: true,
    lead: "This deletes the organization with every project, fleet, API key, invite and all stored emulator state. Fleet URLs stop answering at once. It cannot be undone.",
    fields: [
      {
        kind: "text",
        name: "confirm",
        label: `Type ${org.slug} to confirm`,
        hint: "This is the organization's slug.",
        required: `Type ${org.slug} to confirm that you want to delete it.`,
        attrs: { autocapitalize: "none", spellcheck: "false" },
      },
    ],
    check: ({ confirm }) =>
      confirm && confirm !== org.slug
        ? { confirm: `That does not match. Type ${org.slug} exactly.` }
        : {},
    submit: "Delete organization",
    pending: "Deleting…",
    cancel: back,
    failed: "The organization was not deleted.",
    run: async () => {
      await api("DELETE", `/orgs/${org.id}`)
      await land(to("orgs"), { note: { about: "orgs", text: `${org.name} was deleted just now.` } })
    },
  })
}
