import { mutation } from "../form.js"
import {
  A,
  Aside,
  action,
  type Child,
  Code,
  type Crumb,
  Crumbs,
  DeclareIt,
  Empty,
  Head,
  JustNow,
  LinkList,
  LinkRow,
  ManagedNotice,
  Notice,
  Properties,
  Removed,
  Section,
} from "../kit.js"
import type { Context } from "../router.js"
import { ORG_TABS, type OrgTabId, titleOf, to } from "../routes.js"
import { api, aRole, atLeast, declared, deny, land } from "../runtime.js"
import type { Me, Org, Project } from "../types.js"
import { auditLog } from "./audit.js"
import { configuration } from "./configuration.js"
import { keys } from "./keys.js"
import { members } from "./members.js"
import { usage } from "./usage.js"

export type TabContext = { me: Me; org: Org; admin: boolean }
/** A tab's content and the one action the organization's header offers while it is shown. */
export type Tab = { action?: Child; body: Child }

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
export const orgCrumbs = (org: Org, ...rest: Crumb[]) => (
  <Crumbs
    items={[
      { href: to("orgs"), label: "Organizations" },
      rest.length > 0 ? { href: to("org", { org: org.id }), label: org.name } : org.name,
      ...rest,
    ]}
  />
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

/** The organization's tabs: links, the current one marked. */
const Tabs = ({ org, admin, shown }: { org: Org; admin: boolean; shown: OrgTabId }) => (
  <nav
    aria-label="Organization"
    className="-mx-4 mb-6 flex items-center gap-1 overflow-x-auto border-b border-separator px-4 pb-2 sm:mx-0 sm:px-0"
  >
    {ORG_TABS.filter((entry) => admin || !entry.admin).map((entry) => (
      <a
        key={entry.id}
        href={to(entry.route, { org: org.id })}
        {...(shown === entry.id ? { "aria-current": "page" as const } : {})}
        className={`inline-flex shrink-0 items-center rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors hover:bg-default hover:text-foreground ${
          shown === entry.id ? "bg-default text-foreground" : "text-muted"
        }`}
      >
        {entry.label}
      </a>
    ))}
  </nav>
)

export async function orgScreen({ me, route, params }: Context) {
  const org = await api<Org>("GET", `/orgs/${params.org}`)
  const admin = atLeast(org.role, "admin")
  const shown = ORG_TABS.find((tab) => tab.route === route.id) ?? ORG_TABS[0]
  // The API refuses these tabs' calls for anyone below admin; say so instead of asking.
  if (shown.admin && !admin)
    deny(`${shown.label} is for admins and owners of ${org.name}. You are ${aRole(org.role)}.`)
  const tab = await TAB_BODY[shown.id]({ me, org, admin })
  return (
    <>
      {orgCrumbs(org)}
      <Head
        title={org.name}
        sub={
          <>
            You are {aRole(org.role)} of this organization.
            <JustNow about={`org:${org.id}`} />
          </>
        }
        actions={tab.action}
      />
      {org.suspended ? (
        <Notice tone="warning">
          <strong>This organization is suspended: {org.suspended}.</strong> Its fleets do not serve
          requests, and nothing can be created or changed until the operator of this server lifts
          the suspension. You can still look and delete.
        </Notice>
      ) : null}
      <Tabs org={org} admin={admin} shown={shown.id} />
      {tab.body}
    </>
  )
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
    body: (
      <>
        <ManagedNotice
          org={org}
          readOnly="This organization's projects, fleets and emulators are declared in the file, so they are read-only here."
        />
        <Removed about={`projects:${org.id}`} />
        {list.length > 0 ? (
          <LinkList label="Projects">
            {list.map((project) => (
              <LinkRow
                key={project.id}
                href={to("project", { project: project.id })}
                title={project.name}
                meta={project.slug}
              />
            ))}
          </LinkList>
        ) : org.managed ? (
          <Empty title="No projects yet">
            The file declares no projects. Add one to it and apply it.
          </Empty>
        ) : canCreate ? (
          <DeclareIt
            title="No projects yet"
            orgId={org.id}
            what="this organization's projects, fleets and emulators"
            aside="A project groups the fleets of one application. Create the first one."
          />
        ) : (
          <Empty title="No projects yet">
            A project groups the fleets of one application. A member of the organization can create
            one.
          </Empty>
        )}
      </>
    ),
  }
}

function settings({ org }: TabContext): Tab {
  return {
    body: (
      <>
        <ManagedNotice
          org={org}
          readOnly="The organization's name is declared in the file, so it is read-only here."
        />
        <Properties
          label="Organization settings"
          rows={[
            {
              name: "Name",
              value: org.name,
              about: `org-name:${org.id}`,
              change: !org.managed && (
                <A href={to("org.rename", { org: org.id })} aria-label="Rename the organization">
                  Rename
                </A>
              ),
            },
            {
              name: "Slug",
              value: (
                <>
                  <Code>{org.slug}</Code>
                  <Aside>Permanent</Aside>
                </>
              ),
            },
            { name: "ID", value: <Code>{org.id}</Code> },
          ]}
        />
        {org.role === "owner" ? (
          <Section
            title="Delete this organization"
            sub="Deletes every project, fleet, API key and all stored emulator state. This cannot be undone."
          >
            <div>{action(to("org.delete", { org: org.id }), "Delete organization…", "danger")}</div>
          </Section>
        ) : null}
      </>
    ),
  }
}

export async function orgRename({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Renaming the organization")
  const back = to("org.settings", { org: org.id })
  declared(org, "Renaming the organization", { href: back, label: "Back to Settings" })
  return mutation({
    title: titleOf(route, { organization: org.name }),
    crumbs: orgCrumbs(org, { href: back, label: "Settings" }, "Rename"),
    lead: "The name is what members see. The slug and every fleet URL stay the same.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        value: org.name,
        hint: "Up to 80 characters.",
        required: "Enter a name for the organization.",
        attrs: { maxLength: 80 },
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
    crumbs: orgCrumbs(org, { href: back, label: "Settings" }, "Delete"),
    danger: true,
    lead: "This deletes the organization with every project, fleet, API key, invite and all stored emulator state. Fleet URLs stop answering at once. It cannot be undone.",
    fields: [
      {
        kind: "text",
        name: "confirm",
        label: `Type ${org.slug} to confirm`,
        hint: "This is the organization's slug.",
        required: `Type ${org.slug} to confirm that you want to delete it.`,
        attrs: { autoCapitalize: "none", spellCheck: false },
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
