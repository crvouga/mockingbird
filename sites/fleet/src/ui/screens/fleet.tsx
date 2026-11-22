import { StatusChip } from "@crvouga/mockingbird-ui/react"
import { buttonVariants, Card } from "@heroui/react"
import { useState } from "react"
import { mutation } from "../form.js"
import {
  A,
  action,
  Code,
  Copyable,
  type Crumb,
  DeclareIt,
  Empty,
  Head,
  JustNow,
  LocalButton,
  ManagedNotice,
  Notice,
  PreferFile,
  Properties,
  Removed,
  Section,
  saveFile,
} from "../kit.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { api, aRole, atLeast, count, declared, deny, land, ui } from "../runtime.js"
import type { CatalogEntry, Emulator, Fleet, Org, Project, UsageReport } from "../types.js"
import { projectCrumbs, projectDeclared, projectFor } from "./project.js"

/** Durability mode → its name, what it costs, and what a crash loses. */
export const DURABILITY: Record<string, [string, string]> = {
  strict: [
    "Strict",
    "Committed to storage before every response. Slowest; nothing acknowledged is ever lost.",
  ],
  buffered: [
    "Buffered",
    "Served from memory, saved moments later. Fast; a crash loses the last seconds.",
  ],
  ephemeral: ["Ephemeral", "Memory only. Fastest; state is gone when the service restarts."],
}

/** Who may call a fleet → how the choice reads, and what it means. */
export const FLEET_ACCESS: [string, string, string][] = [
  [
    "open",
    "Anyone with the URL",
    "No Mockingbird credential is needed: vendor SDKs work with only the vendor's own auth. Anyone who learns the URL can call the emulators.",
  ],
  [
    "key",
    "Only requests with an API key",
    "Every request must carry x-mockingbird-api-key with a key of this organization or project. Requests without one are refused.",
  ],
]

/** What an emulator's tag can say about its stored state. */
export const EMULATOR_STATES = [
  "save failing",
  "not stored",
  "unsaved changes",
  "saved",
  "no changes yet",
  "idle",
] as const

export function emulatorState(emulator: Emulator): (typeof EMULATOR_STATES)[number] {
  const { status } = emulator
  if (status.lastError) return "save failing"
  if (emulator.durability === "ephemeral") return "not stored"
  if (status.dirty) return "unsaved changes"
  if (status.lastSavedAt) return "saved"
  return status.loaded ? "no changes yet" : "idle"
}

/** An emulator's stored state, as a status: amber when something is waiting or failing. */
function StateTag({ emulator }: { emulator: Emulator }) {
  const { status } = emulator
  const state = emulatorState(emulator)
  if (state === "save failing" || state === "unsaved changes")
    return <StatusChip status="warning">{state}</StatusChip>
  if (state === "saved")
    return (
      <StatusChip status="ok">
        saved {new Date(status.lastSavedAt ?? "").toLocaleTimeString()}
      </StatusChip>
    )
  return <StatusChip status="neutral">{state}</StatusChip>
}

export type FleetContext = {
  fleet: Fleet
  project: Project
  org: Org | undefined
  role: string | undefined
}

/** Read a fleet, its project and the caller's role. An unknown role is left to the API to judge. */
export async function fleetFor(fleetId: string, minimum?: string, what = "This") {
  const fleet = await api<Fleet>("GET", `/fleets/${fleetId}`)
  const { project, org, role } = await projectFor(fleet.projectId)
  if (minimum && org && !atLeast(role, minimum))
    deny(`${what} is for ${minimum}s and above of ${org.name}. You are ${aRole(role)}.`)
  return { fleet, project, org, role }
}

/** Refuse the form for a hand edit of a fleet that the organization's file declares. */
export const fleetDeclared = ({ fleet, org }: FleetContext, what: string) =>
  declared(org, what, { href: to("fleet", { fleet: fleet.id }), label: `Back to ${fleet.name}` })

export const fleetCrumbs = ({ fleet, project, org }: FleetContext, ...rest: Crumb[]) =>
  projectCrumbs(
    { project, org, role: org?.role },
    rest.length > 0 ? { href: to("fleet", { fleet: fleet.id }), label: fleet.name } : fleet.name,
    ...rest,
  )

export const loadCatalog = async () => {
  ui.catalog ??= (await api<{ data: CatalogEntry[] }>("GET", "/catalog")).data
  return ui.catalog
}

export const accessLabel = (access: string) =>
  FLEET_ACCESS.find(([value]) => value === access)?.[1] ?? access

/** Download an emulator's stored state as a file; a failure is said under the button. */
function DownloadState({ fleet, name }: { fleet: Fleet; name: string }) {
  const [problem, setProblem] = useState<string>()
  return (
    <>
      <LocalButton
        local="download"
        variant="ghost"
        size="sm"
        label={`Download the state of ${name}`}
        onPress={async () => {
          setProblem(undefined)
          try {
            const state = await api("GET", `/fleets/${fleet.id}/emulators/${name}/state`)
            saveFile(
              `${fleet.slug}-${name}-state.json`,
              JSON.stringify(state, null, 2),
              "application/json",
            )
          } catch (error) {
            setProblem(`The state was not downloaded: ${(error as Error).message}`)
          }
        }}
      >
        Download state
      </LocalButton>
      {problem ? <p className="field-error w-full text-sm text-danger">{problem}</p> : null}
    </>
  )
}

/** One emulator of a fleet: its URL, its durability and what can be done to its state. */
function EmulatorCard({
  fleet,
  name,
  emulator,
  entry,
  canChange,
  canDeclare,
}: {
  fleet: Fleet
  name: string
  emulator: Emulator
  entry: CatalogEntry | undefined
  canChange: boolean
  canDeclare: boolean
}) {
  const [mode, consequence] = DURABILITY[emulator.durability] ?? [emulator.durability, ""]
  const here = { fleet: fleet.id, name }
  return (
    <Card render={(props) => <article {...props} aria-label={name} />}>
      <Card.Header
        render={(props) => <header {...props} />}
        className="flex-row flex-wrap items-start gap-2"
      >
        <div className="min-w-0 flex-1">
          <Card.Title className="font-mono text-base">{name}</Card.Title>
          <Card.Description>
            {entry?.displayName ?? emulator.target}
            {entry ? ` · ${entry.category}` : null}
          </Card.Description>
        </div>
        <JustNow about={`emulator:${name}`} />
        <StateTag emulator={emulator} />
      </Card.Header>
      <Card.Content className="gap-3">
        {emulator.status.lastError ? (
          <Notice tone="warning">
            <strong>Saving is failing. </strong>
            {emulator.status.lastError}
          </Notice>
        ) : null}
        <Copyable value={emulator.url} label="Copy URL" />
        <Properties
          label={`Settings of ${name}`}
          rows={[
            {
              name: "Durability",
              value: (
                <>
                  <strong>{mode}</strong>
                  <span className="block text-muted">{consequence}</span>
                </>
              ),
              about: `emulator-durability:${name}`,
              change: canDeclare && (
                <A
                  href={to("emulator.durability", here)}
                  aria-label={`Change the durability of ${name}`}
                >
                  Change
                </A>
              ),
            },
          ]}
        />
      </Card.Content>
      <Card.Footer className="flex-wrap items-center gap-2 border-t border-separator pt-3">
        {canChange && emulator.durability === "buffered" ? (
          <a
            href={to("emulator.save", here)}
            aria-label={`Save ${name} now`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Save now
          </a>
        ) : null}
        <DownloadState fleet={fleet} name={name} />
        {canChange ? (
          <a
            href={to("emulator.reset", here)}
            aria-label={`Reset the state of ${name}`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Reset state
          </a>
        ) : null}
        {canDeclare ? (
          <a
            href={to("emulator.remove", here)}
            aria-label={`Remove ${name}`}
            className={buttonVariants({ variant: "danger-soft", size: "sm" })}
          >
            Remove
          </a>
        ) : null}
      </Card.Footer>
    </Card>
  )
}

export async function fleetScreen({ params }: Context) {
  const context = await fleetFor(params.fleet ?? "")
  const { fleet, org } = context
  const catalog = await loadCatalog()
  // Everything a fleet lets you change needs the member role.
  const canChange = !org || atLeast(org.role, "member")
  // What the organization's mockingbird.yaml declares is shown without the links that change it;
  // operating an emulator (saving, resetting, downloading its state) stays.
  const canDeclare = canChange && !org?.managed
  const at = { fleet: fleet.id }
  const names = Object.keys(fleet.emulators).sort()
  const change = (route: Parameters<typeof to>[0], label: string, what: string) =>
    canDeclare && (
      <A href={to(route, at)} aria-label={what}>
        {label}
      </A>
    )

  return (
    <>
      {fleetCrumbs(context)}
      <Head
        title={fleet.name}
        sub={
          <>
            {canChange
              ? "Point each vendor SDK's base URL at its emulator below."
              : "You are a viewer: you can look at this fleet and use its URLs, not change it."}
            <JustNow about={`fleet:${fleet.id}`} />
          </>
        }
        actions={
          canDeclare &&
          action(to("emulator.add", at), "Add an emulator", names.length > 0 ? "primary" : "plain")
        }
      />
      <ManagedNotice
        org={org}
        readOnly={
          canChange
            ? "This fleet and its emulators are declared in the file, so they are read-only here. You can still save, reset and download emulator state."
            : "This fleet and its emulators are declared in the file, so they are read-only here."
        }
      />
      <Properties
        label="Fleet settings"
        rows={[
          { name: "URL", value: <Copyable value={fleet.url} label="Copy URL" /> },
          {
            name: "Name",
            value: fleet.name,
            about: `fleet-name:${fleet.id}`,
            change: change("fleet.rename", "Rename", "Rename the fleet"),
          },
          {
            name: "Who can call it",
            value: accessLabel(fleet.access),
            about: `fleet-access:${fleet.id}`,
            change: change("fleet.access", "Change", "Change who can call the fleet"),
          },
          {
            name: "Requests per minute",
            value: fleet.requestsPerMinute
              ? fleet.requestsPerMinute.toLocaleString()
              : "The organization's ceiling",
            about: `fleet-rate:${fleet.id}`,
            change: change("fleet.rate-limit", "Change", "Change the requests per minute"),
          },
        ]}
      />
      <Section title="Emulators">
        <Removed about={`emulators:${fleet.id}`} />
        {names.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {names.map((name) => {
              const emulator = fleet.emulators[name] as Emulator
              return (
                <EmulatorCard
                  key={name}
                  fleet={fleet}
                  name={name}
                  emulator={emulator}
                  entry={catalog.find((item) => item.target === emulator.target)}
                  canChange={canChange}
                  canDeclare={canDeclare}
                />
              )
            })}
          </div>
        ) : org?.managed ? (
          <Empty title="This fleet has no emulators">
            The file declares no services for this fleet. Add one to it and apply it.
          </Empty>
        ) : canChange ? (
          <DeclareIt
            title="This fleet has no emulators"
            orgId={fleet.orgId}
            what="this fleet's emulators"
            aside="Add one to get its URL."
          />
        ) : (
          <Empty title="This fleet has no emulators">
            A member of the organization can add emulators.
          </Empty>
        )}
      </Section>
      {canDeclare ? (
        <Section
          title="Delete this fleet"
          sub="Its URL stops answering and all emulator state is erased."
        >
          <div>{action(to("fleet.delete", at), "Delete fleet…", "danger")}</div>
        </Section>
      ) : null}
    </>
  )
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
export const slugProblem =
  "Use lowercase letters, digits and hyphens, 1 to 40 characters, not starting or ending with a hyphen."

export async function fleetNew({ route, params }: Context) {
  const context = await projectFor(params.project ?? "", "member", "Creating fleets")
  const { project } = context
  const back = to("project", { project: project.id })
  projectDeclared(context, "Creating fleets")
  return mutation({
    title: route.title,
    crumbs: projectCrumbs(context, "New fleet"),
    lead: `A fleet in ${project.name} is a set of emulators behind one stable URL. You add the emulators next.`,
    note: <PreferFile orgId={project.orgId} what="the fleet and its emulators" />,
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "The environment it serves, for example Staging. Up to 80 characters.",
        required: "Enter a name for the fleet.",
        attrs: { maxLength: 80 },
      },
      {
        kind: "text",
        name: "slug",
        label: "URL slug (optional)",
        hint: (
          <>
            The fleet is served at <Code>{`${ui.address.origin()}/f/<slug>`}</Code>. It is permanent
            and unique across this server. Leave it empty to get one made from the name.
          </>
        ),
        attrs: { autoCapitalize: "none", spellCheck: false, maxLength: 40 },
      },
    ],
    check: ({ slug }) => (slug && !SLUG.test(slug) ? { slug: slugProblem } : {}),
    place: (error) => (error.status === 409 ? "slug" : undefined),
    submit: "Create fleet",
    pending: "Creating…",
    cancel: back,
    failed: "The fleet was not created.",
    run: async ({ name, slug }) => {
      const fleet = await api<Fleet>("POST", `/projects/${project.id}/fleets`, {
        name,
        ...(slug ? { slug } : {}),
      })
      await land(to("fleet", { fleet: fleet.id }), {
        note: { about: `fleet:${fleet.id}`, text: "Created just now" },
      })
    },
  })
}

export async function fleetRename({ route, params }: Context) {
  const context = await fleetFor(params.fleet ?? "", "member", "Renaming a fleet")
  fleetDeclared(context, "Renaming a fleet")
  const { fleet } = context
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { fleet: fleet.name }),
    crumbs: fleetCrumbs(context, "Rename"),
    lead: "Only the name changes. The fleet's URL stays the same.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        value: fleet.name,
        hint: "Up to 80 characters.",
        required: "Enter a name for the fleet.",
        attrs: { maxLength: 80 },
      },
    ],
    submit: "Rename fleet",
    pending: "Renaming…",
    cancel: back,
    failed: "The fleet was not renamed.",
    run: async ({ name }) => {
      await api("PATCH", `/fleets/${fleet.id}`, { name })
      await land(back, { note: { about: `fleet-name:${fleet.id}`, text: "Renamed just now" } })
    },
  })
}

export async function fleetAccess({ route, params }: Context) {
  const context = await fleetFor(params.fleet ?? "", "member", "Changing a fleet's access")
  fleetDeclared(context, "Changing a fleet's access")
  const { fleet } = context
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { fleet: fleet.name }),
    crumbs: fleetCrumbs(context, "Access"),
    lead: "This applies to every emulator in the fleet within a few seconds. Each emulator's /__admin routes always need a member key, whichever you choose.",
    fields: [
      {
        kind: "choice",
        name: "access",
        label: "Who can call this fleet",
        value: fleet.access,
        options: FLEET_ACCESS.map(([value, label, description]) => ({
          value,
          label,
          description,
          ...(value === fleet.access ? { note: "Current" } : {}),
        })),
      },
    ],
    check: ({ access }) =>
      access === fleet.access
        ? { access: "This is who can call the fleet now. Choose the other option, or cancel." }
        : {},
    submit: "Save access",
    pending: "Saving…",
    cancel: back,
    failed: "Access was not changed.",
    run: async ({ access }) => {
      await api("PATCH", `/fleets/${fleet.id}`, { access })
      await land(back, { note: { about: `fleet-access:${fleet.id}`, text: "Changed just now" } })
    },
  })
}

export async function fleetRateLimit({ route, params }: Context) {
  const context = await fleetFor(params.fleet ?? "", "member", "Changing a fleet's rate limit")
  fleetDeclared(context, "Changing a fleet's rate limit")
  const { fleet } = context
  const ceiling = await api<UsageReport>("GET", `/orgs/${fleet.orgId}/usage`)
    .then((report) => report.limits.fleetRequestsPerMinute ?? 0)
    .catch(() => 0)
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { fleet: fleet.name }),
    crumbs: fleetCrumbs(context, "Requests per minute"),
    lead: `Requests beyond this number in a minute are answered 429. ${
      fleet.requestsPerMinute
        ? `The fleet accepts ${fleet.requestsPerMinute.toLocaleString()} a minute now.`
        : "The fleet has no limit of its own now, so the organization's ceiling applies."
    }`,
    fields: [
      {
        kind: "text",
        type: "number",
        name: "requestsPerMinute",
        label: "Requests per minute",
        value: fleet.requestsPerMinute ? String(fleet.requestsPerMinute) : "",
        hint:
          ceiling > 0
            ? `A whole number from 1 to ${ceiling.toLocaleString()}, the organization's ceiling.`
            : "A whole number, 1 or more.",
        required: "Enter how many requests a minute the fleet accepts.",
        attrs: { min: 1, step: 1, inputMode: "numeric" },
      },
    ],
    check: ({ requestsPerMinute }) => {
      if (!requestsPerMinute) return {}
      const value = Number(requestsPerMinute)
      if (!Number.isInteger(value) || value < 1)
        return { requestsPerMinute: "Enter a whole number, 1 or more." }
      if (ceiling > 0 && value > ceiling)
        return {
          requestsPerMinute: `Enter ${ceiling.toLocaleString()} or less: that is the organization's ceiling.`,
        }
      return {}
    },
    place: (error) => (error.status === 400 ? "requestsPerMinute" : undefined),
    submit: "Save rate limit",
    pending: "Saving…",
    cancel: back,
    failed: "The rate limit was not changed.",
    run: async ({ requestsPerMinute }) => {
      await api("PATCH", `/fleets/${fleet.id}`, { requestsPerMinute: Number(requestsPerMinute) })
      await land(back, { note: { about: `fleet-rate:${fleet.id}`, text: "Changed just now" } })
    },
  })
}

export async function fleetDelete({ route, params }: Context) {
  const context = await fleetFor(params.fleet ?? "", "member", "Deleting a fleet")
  fleetDeclared(context, "Deleting a fleet")
  const { fleet, project } = context
  const names = Object.keys(fleet.emulators).sort()
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { fleet: fleet.name }),
    crumbs: fleetCrumbs(context, "Delete"),
    danger: true,
    lead: (
      <>
        <Code>{fleet.url}</Code> stops answering at once
        {names.length > 0
          ? `, and the stored state of its ${count(names.length, "emulator")} (${names.join(", ")}) is erased.`
          : ". It has no emulators."}{" "}
        It cannot be undone.
      </>
    ),
    submit: "Delete fleet",
    pending: "Deleting…",
    cancel: back,
    failed: "The fleet was not deleted.",
    run: async () => {
      await api("DELETE", `/fleets/${fleet.id}`)
      await land(to("project", { project: project.id }), {
        note: { about: `fleets:${project.id}`, text: `${fleet.name} was deleted just now.` },
      })
    },
  })
}
