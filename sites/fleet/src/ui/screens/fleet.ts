import { h } from "../dom.js"
import {
  act,
  api,
  atLeast,
  confirmThen,
  copyable,
  crumbs,
  field,
  flashSlot,
  form,
  link,
  ui,
} from "../runtime.js"
import type { CatalogEntry, Emulator, Fleet, Org, Project } from "../types.js"

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

/** Who may call a fleet → how the choice reads. */
export const FLEET_ACCESS: [string, string][] = [
  ["open", "Anyone with the URL"],
  ["key", "Only requests with an API key (x-mockingbird-api-key)"],
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

/** How many catalog entries a search lists. */
export const CATALOG_PAGE = 40

export const searchCatalog = (catalog: CatalogEntry[], search: string) => {
  const query = search.trim().toLowerCase()
  return catalog
    .filter(
      (entry) =>
        !query ||
        `${entry.target} ${entry.displayName} ${entry.category}`.toLowerCase().includes(query),
    )
    .slice(0, CATALOG_PAGE)
}

function stateTag(emulator: Emulator) {
  const { status } = emulator
  const state = emulatorState(emulator)
  if (state === "save failing")
    return h("span.tag.warn", { title: status.lastError ?? "" }, "save failing")
  if (state === "unsaved changes") return h("span.tag.warn", {}, "unsaved changes")
  if (state === "saved")
    return h("span.tag.ok", {}, `saved ${new Date(status.lastSavedAt ?? "").toLocaleTimeString()}`)
  return h("span.tag", {}, state)
}

export async function fleetScreen(fleetId: string) {
  const fleet = await api<Fleet>("GET", `/fleets/${fleetId}`)
  const [project, org] = await Promise.all([
    api<Project>("GET", `/projects/${fleet.projectId}`),
    api<Org>("GET", `/orgs/${fleet.orgId}`).catch(() => undefined),
  ])
  // Everything a fleet lets you change needs the member role. Without the organization the role
  // is unknown: offer the controls and let the API decide.
  const canChange = !org || atLeast(org.role, "member")
  ui.catalog ??= (await api<{ data: CatalogEntry[] }>("GET", "/catalog")).data
  const catalog = ui.catalog
  const names = Object.keys(fleet.emulators).sort()
  const emulatorPath = (name: string) => `/fleets/${fleetId}/emulators/${name}`

  const card = (name: string, emulator: Emulator) => {
    const entry = catalog.find((item) => item.target === emulator.target)
    return h(
      "article.emulator",
      { "aria-label": name },
      h(
        "header",
        {},
        h(
          "h2.grow",
          {},
          name,
          name !== emulator.target &&
            h("span.sub", {}, ` · ${entry?.displayName ?? emulator.target}`),
        ),
        stateTag(emulator),
      ),
      h(
        ".body",
        {},
        entry && h("p.sub", {}, entry.description),
        copyable(emulator.url, "Copy URL"),
        h(
          ".durability",
          { role: "group", "aria-label": `Durability of ${name}` },
          Object.entries(DURABILITY).map(([mode, [label, consequence]]) =>
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(emulator.durability === mode),
                disabled: !canChange,
                onclick: act(() =>
                  emulator.durability === mode
                    ? Promise.resolve()
                    : api("PATCH", emulatorPath(name), { durability: mode }),
                ),
              },
              h("b", {}, label),
              h("span", {}, consequence),
            ),
          ),
        ),
        canChange &&
          h(
            ".actions",
            {},
            emulator.durability === "buffered" &&
              h(
                "button.small",
                { type: "button", onclick: act(() => api("POST", `${emulatorPath(name)}/flush`)) },
                "Save now",
              ),
            h(
              "button.small",
              {
                type: "button",
                onclick: async () =>
                  download(
                    `${fleet.slug}-${name}-state.json`,
                    await api("GET", `${emulatorPath(name)}/state`),
                  ),
              },
              "Download state",
            ),
            h(
              "button.small.danger",
              {
                type: "button",
                onclick: confirmThen(`Reset ${name}? Its state is erased.`, () =>
                  api("POST", `${emulatorPath(name)}/reset`),
                ),
              },
              "Reset state",
            ),
            h(
              "button.small.danger",
              {
                type: "button",
                onclick: confirmThen(`Remove ${name} from this fleet? Its state is erased.`, () =>
                  api("DELETE", emulatorPath(name)),
                ),
              },
              "Remove",
            ),
          ),
      ),
    )
  }

  const results = h(".catalog", { hidden: true, role: "region", "aria-label": "Catalog" })
  const search = h("input", {
    type: "search",
    placeholder: `Search ${catalog.length} emulators: stripe, s3, twilio…`,
    "aria-label": "Search emulators",
  }) as HTMLInputElement
  const showResults = () => {
    const matches = searchCatalog(catalog, search.value)
    results.hidden = false
    results.replaceChildren(
      ...(matches.length > 0
        ? matches.map((entry) => {
            // A second instance of the same emulator gets a numbered name.
            let name = entry.target
            for (let n = 2; fleet.emulators[name]; n++) name = `${entry.target}-${n}`
            return h(
              "button",
              {
                type: "button",
                onclick: act(() =>
                  api("PUT", emulatorPath(name), { target: entry.target, durability: "buffered" }),
                ),
              },
              h("b", {}, entry.displayName),
              h("small", {}, `${entry.category} · ${entry.description}`),
            )
          })
        : [h("p.row.meta", {}, "No emulator matches that search.")]),
    )
  }
  search.addEventListener("input", showResults)
  search.addEventListener("focus", showResults)

  return [
    crumbs(
      link(`/orgs/${fleet.orgId}`, {}, "Organization"),
      link(`/projects/${project.id}`, {}, project.name),
      fleet.name,
    ),
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, fleet.name),
        h("p.sub", {}, "Point each vendor SDK's base URL at its emulator below."),
        !canChange &&
          h("p.sub", {}, "You are a viewer: you can look at this fleet, not change it."),
      ),
      canChange &&
        h(
          "button.danger",
          {
            type: "button",
            onclick: confirmThen(
              `Delete ${fleet.name}? Its URL stops working and all emulator state is erased.`,
              () => api("DELETE", `/fleets/${fleetId}`),
              () => ui.address.replace(`/projects/${project.id}`),
            ),
          },
          "Delete fleet",
        ),
    ),
    flashSlot(),
    h(
      "section.stack",
      {},
      copyable(fleet.url, "Copy fleet URL"),
      h(
        "label.field",
        {},
        "Who can call this fleet",
        h(
          "select",
          {
            // The label's own text would otherwise run on into the options'.
            "aria-label": "Who can call this fleet",
            disabled: !canChange,
            onchange: (event) =>
              void act(() =>
                api("PATCH", `/fleets/${fleetId}`, {
                  access: (event.target as HTMLSelectElement).value,
                }),
              )(event),
          },
          FLEET_ACCESS.map(([access, label]) =>
            h("option", { value: access, selected: fleet.access === access }, label),
          ),
        ),
      ),
      h(
        "form.inline.rate",
        {
          onsubmit: act(() =>
            api("PATCH", `/fleets/${fleetId}`, {
              requestsPerMinute: Number(field(form("form.rate"), "rpm")),
            }),
          ),
        },
        h(
          "label.field",
          {},
          "Requests per minute this fleet accepts (blank: the organization's ceiling)",
          h("input", {
            name: "rpm",
            type: "number",
            min: "1",
            required: true,
            disabled: !canChange,
            value: fleet.requestsPerMinute ? String(fleet.requestsPerMinute) : "",
            placeholder: "organization ceiling",
          }),
        ),
        canChange && h("button", {}, "Set rate limit"),
      ),
    ),
    h(
      "section",
      {},
      h("h2", {}, "Emulators"),
      names.length > 0
        ? names.map((name) => card(name, fleet.emulators[name] as Emulator))
        : h(
            ".empty",
            {},
            h("strong", {}, "This fleet is empty"),
            canChange
              ? "Add an emulator below."
              : "A member of the organization can add emulators.",
          ),
    ),
    canChange && h("section", {}, h("h2", {}, "Add an emulator"), search, results),
  ]
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  )
  const anchor = h("a", { href: url, download: name })
  anchor.click()
  URL.revokeObjectURL(url)
}
