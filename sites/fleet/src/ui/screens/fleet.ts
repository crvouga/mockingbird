import { type Child, h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import {
  action,
  api,
  aRole,
  atLeast,
  copyable,
  count,
  deny,
  head,
  justNow,
  land,
  link,
  properties,
  removed,
  section,
  ui,
} from "../runtime.js"
import type { CatalogEntry, Emulator, Fleet, Org, Project, UsageReport } from "../types.js"
import { projectCrumbs, projectFor } from "./project.js"

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

function stateTag(emulator: Emulator) {
  const { status } = emulator
  const state = emulatorState(emulator)
  if (state === "save failing" || state === "unsaved changes") return h("span.tag.warn", {}, state)
  if (state === "saved")
    return h("span.tag.ok", {}, `saved ${new Date(status.lastSavedAt ?? "").toLocaleTimeString()}`)
  return h("span.tag", {}, state)
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

export const fleetCrumbs = ({ fleet, project, org }: FleetContext, ...rest: Child[]) =>
  projectCrumbs(
    { project, org, role: org?.role },
    rest.length > 0 ? link(to("fleet", { fleet: fleet.id }), {}, fleet.name) : fleet.name,
    ...rest,
  )

export const loadCatalog = async () => {
  ui.catalog ??= (await api<{ data: CatalogEntry[] }>("GET", "/catalog")).data
  return ui.catalog
}

export const accessLabel = (access: string) =>
  FLEET_ACCESS.find(([value]) => value === access)?.[1] ?? access

export async function fleetScreen({ params }: Context) {
  const context = await fleetFor(params.fleet ?? "")
  const { fleet, org } = context
  const catalog = await loadCatalog()
  // Everything a fleet lets you change needs the member role.
  const canChange = !org || atLeast(org.role, "member")
  const at = { fleet: fleet.id }
  const names = Object.keys(fleet.emulators).sort()
  const change = (route: Parameters<typeof to>[0], label: string, what: string) =>
    canChange && link(to(route, at), { "aria-label": what }, label)

  const card = (name: string, emulator: Emulator) => {
    const entry = catalog.find((item) => item.target === emulator.target)
    const [mode, consequence] = DURABILITY[emulator.durability] ?? [emulator.durability, ""]
    const here = { fleet: fleet.id, name }
    const problem = h("p.field-error", { hidden: true })
    const download = h(
      "button.linklike",
      { type: "button", "data-local": "download", "aria-label": `Download the state of ${name}` },
      "Download state",
    )
    download.addEventListener("click", async () => {
      problem.hidden = true
      try {
        save(
          `${fleet.slug}-${name}-state.json`,
          await api("GET", `/fleets/${fleet.id}/emulators/${name}/state`),
        )
      } catch (error) {
        problem.textContent = `The state was not downloaded: ${(error as Error).message}`
        problem.hidden = false
      }
    })
    return h(
      "article.emulator",
      { "aria-label": name },
      h(
        "header",
        {},
        h(
          ".grow",
          {},
          h("h3", {}, name),
          h(".meta", {}, entry?.displayName ?? emulator.target, entry && ` · ${entry.category}`),
        ),
        justNow(`emulator:${name}`),
        stateTag(emulator),
      ),
      emulator.status.lastError &&
        h("p.notice.warn", {}, h("strong", {}, "Saving is failing. "), emulator.status.lastError),
      copyable(emulator.url, "Copy URL"),
      properties(`Settings of ${name}`, [
        {
          name: "Durability",
          value: [h("strong", {}, mode), h("span.prop-about", {}, consequence)],
          about: `emulator-durability:${name}`,
          change:
            canChange &&
            link(
              to("emulator.durability", here),
              { "aria-label": `Change the durability of ${name}` },
              "Change",
            ),
        },
      ]),
      h(
        "footer.row-links",
        {},
        canChange &&
          emulator.durability === "buffered" &&
          link(to("emulator.save", here), { "aria-label": `Save ${name} now` }, "Save now"),
        download,
        canChange &&
          link(
            to("emulator.reset", here),
            { "aria-label": `Reset the state of ${name}` },
            "Reset state",
          ),
        canChange &&
          link(
            to("emulator.remove", here),
            { class: "danger", "aria-label": `Remove ${name}` },
            "Remove",
          ),
      ),
      problem,
    )
  }

  return [
    fleetCrumbs(context),
    head(
      fleet.name,
      [
        canChange
          ? "Point each vendor SDK's base URL at its emulator below."
          : "You are a viewer: you can look at this fleet and use its URLs, not change it.",
        justNow(`fleet:${fleet.id}`),
      ],
      canChange && action(to("emulator.add", at), "Add an emulator", "primary"),
    ),
    properties("Fleet settings", [
      { name: "URL", value: copyable(fleet.url, "Copy URL") },
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
    ]),
    section(
      "Emulators",
      null,
      removed(`emulators:${fleet.id}`),
      names.length > 0
        ? names.map((name) => card(name, fleet.emulators[name] as Emulator))
        : h(
            ".empty",
            {},
            h("strong", {}, "This fleet has no emulators"),
            canChange
              ? "Add one to get its URL."
              : "A member of the organization can add emulators.",
          ),
    ),
    canChange &&
      section(
        "Delete this fleet",
        null,
        h("p.sub", {}, "Its URL stops answering and all emulator state is erased."),
        h("p", {}, action(to("fleet.delete", at), "Delete fleet…", "danger")),
      ),
  ]
}

function save(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  )
  h("a", { href: url, download: name }).click()
  URL.revokeObjectURL(url)
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
export const slugProblem =
  "Use lowercase letters, digits and hyphens, 1 to 40 characters, not starting or ending with a hyphen."

export async function fleetNew({ route, params }: Context) {
  const context = await projectFor(params.project ?? "", "member", "Creating fleets")
  const { project } = context
  const back = to("project", { project: project.id })
  return mutation({
    title: route.title,
    crumbs: projectCrumbs(context, "New fleet"),
    lead: `A fleet in ${project.name} is a set of emulators behind one stable URL. You add the emulators next.`,
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "The environment it serves, for example Staging. Up to 80 characters.",
        required: "Enter a name for the fleet.",
        attrs: { maxlength: "80" },
      },
      {
        kind: "text",
        name: "slug",
        label: "URL slug (optional)",
        hint: [
          "The fleet is served at ",
          h("code", {}, `${ui.address.origin()}/f/<slug>`),
          ". It is permanent and unique across this server. Leave it empty to get one made from the name.",
        ],
        attrs: { autocapitalize: "none", spellcheck: "false", maxlength: "40" },
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
        attrs: { maxlength: "80" },
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
  const { fleet } = context
  const ceiling = await api<UsageReport>("GET", `/orgs/${fleet.orgId}/usage`)
    .then((report) => report.limits.fleetRequestsPerMinute ?? 0)
    .catch(() => 0)
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { fleet: fleet.name }),
    crumbs: fleetCrumbs(context, "Requests per minute"),
    lead: [
      "Requests beyond this number in a minute are answered 429. ",
      fleet.requestsPerMinute
        ? `The fleet accepts ${fleet.requestsPerMinute.toLocaleString()} a minute now.`
        : "The fleet has no limit of its own now, so the organization's ceiling applies.",
    ],
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
        attrs: { min: "1", step: "1", inputmode: "numeric" },
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
  const { fleet, project } = context
  const names = Object.keys(fleet.emulators).sort()
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { fleet: fleet.name }),
    crumbs: fleetCrumbs(context, "Delete"),
    danger: true,
    lead: [
      h("code", {}, fleet.url),
      " stops answering at once",
      names.length > 0
        ? `, and the stored state of its ${count(names.length, "emulator")} (${names.join(", ")}) is erased.`
        : ". It has no emulators.",
      " It cannot be undone.",
    ],
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
