/** The screens that act on one emulator of a fleet, and the catalog an emulator is added from. */
import { h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { ApiError, api, head, land, link, ui } from "../runtime.js"
import type { CatalogEntry, Emulator } from "../types.js"
import {
  DURABILITY,
  type FleetContext,
  fleetCrumbs,
  fleetFor,
  loadCatalog,
  slugProblem,
} from "./fleet.js"

export const searchCatalog = (catalog: CatalogEntry[], search: string) => {
  const query = search.trim().toLowerCase()
  return catalog.filter(
    (entry) =>
      !query ||
      `${entry.target} ${entry.displayName} ${entry.category}`.toLowerCase().includes(query),
  )
}

/** The first free instance name for an emulator: `stripe`, then `stripe-2`, … */
export function freeName(target: string, taken: Record<string, unknown>) {
  let name = target
  for (let n = 2; taken[name]; n++) name = `${target}-${n}`
  return name
}

const durabilityOptions = (current?: string) =>
  Object.entries(DURABILITY).map(([value, [label, description]]) => ({
    value,
    label,
    description,
    ...(current === undefined
      ? value === "buffered"
        ? { note: "Default" }
        : {}
      : value === current
        ? { note: "Current" }
        : {}),
  }))

/**
 * Step 1 of adding an emulator: find it. This is a query: the search box only filters the list
 * already on screen, and each result links to the form that adds it.
 */
export async function emulatorAdd({ route, params }: Context) {
  const context = await fleetFor(params.fleet ?? "", "member", "Adding emulators")
  const { fleet } = context
  const catalog = [...(await loadCatalog())].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  )
  const here = to("emulator.add", { fleet: fleet.id })
  const running = new Set(Object.values(fleet.emulators).map((emulator) => emulator.target))
  const results = h("div", {})
  const tally = h("p.sub.tally", {})
  const search = h("input", {
    type: "search",
    value: new URLSearchParams(ui.address.search()).get("q") ?? "",
    placeholder: "stripe, payments, s3, email…",
    "aria-label": "Search emulators",
    autocomplete: "off",
  }) as HTMLInputElement
  const show = () => {
    const matches = searchCatalog(catalog, search.value)
    tally.textContent = search.value.trim()
      ? `${matches.length} of ${catalog.length} emulators match.`
      : `${catalog.length} emulators, all HTTP APIs.`
    results.replaceChildren(
      matches.length > 0
        ? h(
            "nav.list",
            { "aria-label": "Catalog" },
            matches.map((entry) =>
              link(
                to("emulator.add.configure", { fleet: fleet.id, target: entry.target }),
                { class: "row" },
                h(
                  ".grow",
                  {},
                  h(".title", {}, entry.displayName),
                  h(".meta.wrap", {}, entry.description),
                ),
                running.has(entry.target) && h("span.tag", {}, "in this fleet"),
                h("span.tag.category", {}, entry.category),
                h("span.chevron", { "aria-hidden": "true" }, "›"),
              ),
            ),
          )
        : h(
            ".empty",
            {},
            h("strong", {}, `No emulator matches “${search.value.trim()}”`),
            "Search by vendor or category, for example stripe, email or storage.",
          ),
    )
  }
  search.addEventListener("input", () => {
    // The search is part of the address, so Back returns to the same results.
    const query = search.value.trim()
    ui.address.replace(query ? `${here}?q=${encodeURIComponent(query)}` : here)
    show()
  })
  show()
  return [
    fleetCrumbs(context, "Add an emulator"),
    head(
      titleOf(route, { fleet: fleet.name }),
      "Choose what to emulate. On the next screen you name it and choose how durable its state is.",
    ),
    h(".search", {}, search),
    tally,
    results,
  ]
}

export async function emulatorConfigure({ route, params }: Context) {
  const context = await fleetFor(params.fleet ?? "", "member", "Adding emulators")
  const { fleet } = context
  const entry = (await loadCatalog()).find((item) => item.target === params.target)
  if (!entry) throw new ApiError(404, `The catalog has no emulator called ${params.target}.`)
  const back = to("emulator.add", { fleet: fleet.id })
  const suggested = freeName(entry.target, fleet.emulators)
  return mutation({
    title: titleOf(route, { emulator: entry.displayName, fleet: fleet.name }),
    crumbs: fleetCrumbs(context, link(back, {}, "Add an emulator"), entry.displayName),
    lead: entry.description,
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Instance name",
        value: suggested,
        hint: [
          "The last part of its URL: ",
          h("code", {}, `${fleet.url}/<name>`),
          ". Lowercase letters, digits and hyphens. It cannot be changed later.",
          suggested !== entry.target &&
            ` This fleet already runs ${entry.target}, so this one is numbered.`,
        ],
        required: "Enter a name for this emulator.",
        attrs: { autocapitalize: "none", spellcheck: "false", maxlength: "40" },
      },
      {
        kind: "choice",
        name: "durability",
        label: "Durability",
        hint: "How much of its state survives a crash or restart. You can change this at any time.",
        value: "buffered",
        options: durabilityOptions(),
      },
    ],
    check: ({ name }) => {
      if (!name) return {}
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) return { name: slugProblem }
      if (fleet.emulators[name])
        return { name: `This fleet already has an emulator named ${name}. Choose another name.` }
      return {}
    },
    place: (error) => (error.status === 400 ? "name" : undefined),
    submit: "Add emulator",
    pending: "Adding…",
    cancel: back,
    failed: "The emulator was not added.",
    run: async ({ name, durability }) => {
      await api("PUT", `/fleets/${fleet.id}/emulators/${name}`, {
        target: entry.target,
        durability,
      })
      await land(to("fleet", { fleet: fleet.id }), {
        note: { about: `emulator:${name}`, text: "Added just now" },
      })
    },
  })
}

/** The emulator a mutation acts on, with the fleet it is in. */
async function emulatorFor(params: Record<string, string>, what: string) {
  const context = await fleetFor(params.fleet ?? "", "member", what)
  const name = params.name ?? ""
  const emulator = context.fleet.emulators[name]
  if (!emulator) throw new ApiError(404, `${context.fleet.name} has no emulator named ${name}.`)
  return { context, name, emulator }
}

const emulatorCrumbs = (context: FleetContext, name: string, last: string) =>
  fleetCrumbs(context, name, last)

const stored = (emulator: Emulator) =>
  emulator.status.storedBytes
    ? `${emulator.status.storedBytes.toLocaleString()} bytes of stored state`
    : "its state"

export async function emulatorDurability({ route, params }: Context) {
  const { context, name, emulator } = await emulatorFor(params, "Changing durability")
  const { fleet } = context
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { emulator: name }),
    crumbs: emulatorCrumbs(context, name, "Durability"),
    lead: "Durability is how much of this emulator's state survives a crash or restart, and what that costs in speed. A change takes effect on the next request. Choosing Ephemeral deletes the stored copy.",
    fields: [
      {
        kind: "choice",
        name: "durability",
        label: "Durability",
        value: emulator.durability,
        options: durabilityOptions(emulator.durability),
      },
    ],
    check: ({ durability }) =>
      durability === emulator.durability
        ? {
            durability: `${name} is already ${(DURABILITY[durability]?.[0] ?? durability).toLowerCase()}. Choose a different mode, or cancel.`,
          }
        : {},
    submit: "Save durability",
    pending: "Saving…",
    cancel: back,
    failed: "Durability was not changed.",
    run: async ({ durability }) => {
      await api("PATCH", `/fleets/${fleet.id}/emulators/${name}`, { durability })
      await land(back, {
        note: { about: `emulator-durability:${name}`, text: "Changed just now" },
      })
    },
  })
}

export async function emulatorSave({ route, params }: Context) {
  const { context, name, emulator } = await emulatorFor(params, "Saving an emulator")
  const { fleet } = context
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { emulator: name }),
    crumbs: emulatorCrumbs(context, name, "Save now"),
    lead:
      emulator.durability === "buffered"
        ? `${name} is buffered: its changes are written to storage moments after they happen. This writes whatever is unsaved right now, without waiting.`
        : `${name} is ${emulator.durability}, so there is nothing waiting to be saved. Saving now does no harm.`,
    submit: "Save now",
    pending: "Saving…",
    cancel: back,
    failed: "The state was not saved.",
    run: async () => {
      await api("POST", `/fleets/${fleet.id}/emulators/${name}/flush`)
      await land(back, { note: { about: `emulator:${name}`, text: "Saved just now" } })
    },
  })
}

export async function emulatorReset({ route, params }: Context) {
  const { context, name, emulator } = await emulatorFor(params, "Resetting an emulator")
  const { fleet } = context
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { emulator: name }),
    crumbs: emulatorCrumbs(context, name, "Reset"),
    danger: true,
    lead: `This erases ${stored(emulator)}: everything your application created in ${name}. The emulator stays in the fleet at the same URL and starts again empty. It cannot be undone; download the state first if you may want it back.`,
    submit: "Reset state",
    pending: "Resetting…",
    cancel: back,
    failed: "The emulator was not reset.",
    run: async () => {
      await api("POST", `/fleets/${fleet.id}/emulators/${name}/reset`)
      await land(back, { note: { about: `emulator:${name}`, text: "Reset just now" } })
    },
  })
}

export async function emulatorRemove({ route, params }: Context) {
  const { context, name, emulator } = await emulatorFor(params, "Removing an emulator")
  const { fleet } = context
  const back = to("fleet", { fleet: fleet.id })
  return mutation({
    title: titleOf(route, { emulator: name, fleet: fleet.name }),
    crumbs: emulatorCrumbs(context, name, "Remove"),
    danger: true,
    lead: [
      h("code", {}, emulator.url),
      ` stops answering at once and ${stored(emulator)} is erased. It cannot be undone.`,
    ],
    submit: "Remove emulator",
    pending: "Removing…",
    cancel: back,
    failed: "The emulator was not removed.",
    run: async () => {
      await api("DELETE", `/fleets/${fleet.id}/emulators/${name}`)
      await land(back, {
        note: { about: `emulators:${fleet.id}`, text: `${name} was removed just now.` },
      })
    },
  })
}
