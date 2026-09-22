import { score, terms } from "../lib/search.ts"
import type { PaletteEntry } from "../pages/search.json.ts"
import { KEYS, store } from "./storage.ts"

const dialog = document.querySelector<HTMLDialogElement>("[data-palette]")
const input = document.querySelector<HTMLInputElement>("[data-palette-input]")
const list = document.querySelector<HTMLUListElement>("[data-palette-results]")

let entries: PaletteEntry[] | undefined
let results: PaletteEntry[] = []
let active = 0

const load = async (): Promise<PaletteEntry[]> => {
  if (!entries) {
    const response = await fetch("/search.json")
    entries = (await response.json()) as PaletteEntry[]
  }
  return entries
}
void load()

const escapeText = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

function render(query: string) {
  if (!list || !entries) return
  const q = terms(query)
  let groups: [string, PaletteEntry[]][]
  if (q.length === 0) {
    const recentNames = store.getJson<string[]>(KEYS.recent, [])
    const recent = recentNames
      .map((name) => entries?.find((e) => e.kind === "service" && e.name === name))
      .filter((e): e is PaletteEntry => Boolean(e))
    groups = [
      ["Recently viewed", recent],
      ["Pages", entries.filter((e) => e.kind === "page")],
      [
        "Services",
        entries.filter((e) => e.kind === "service" && !recentNames.includes(e.name)).slice(0, 8),
      ],
    ]
  } else {
    const ranked = entries
      .map((entry) => ({ entry, rank: score(q, entry) }))
      .filter((r): r is { entry: PaletteEntry; rank: number } => r.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.entry.displayName.localeCompare(b.entry.displayName))
      .map((r) => r.entry)
    groups = [
      ["Services", ranked.filter((e) => e.kind === "service").slice(0, 12)],
      ["Pages", ranked.filter((e) => e.kind === "page")],
    ]
  }
  groups = groups.filter(([, items]) => items.length > 0)
  results = groups.flatMap(([, items]) => items)
  active = Math.min(active, Math.max(0, results.length - 1))

  if (results.length === 0) {
    list.innerHTML = `<li class="empty">No results for “${escapeText(query)}”</li>`
    return
  }
  let index = 0
  list.innerHTML = groups
    .map(
      ([label, items]) =>
        `<li class="group" role="presentation">${label}</li>${items
          .map((e) => {
            const i = index++
            const icon =
              e.kind === "service"
                ? `<span class="monogram" style="--h:${e.hue}">${escapeText(e.initials)}</span>`
                : `<span class="monogram" style="--h:260"><svg class="i"><use href="#i-file"></use></svg></span>`
            return `<li role="option"><a href="${e.href}" id="pal-${i}" data-index="${i}" aria-selected="${i === active}"><span>${icon}</span><span class="meta"><strong>${escapeText(e.displayName)}</strong><span>${escapeText(e.subtitle)}</span></span><span class="kind">${e.kind === "service" ? escapeText(e.category) : "Page"}</span></a></li>`
          })
          .join("")}`,
    )
    .join("")
  input?.setAttribute("aria-activedescendant", `pal-${active}`)
}

function move(delta: number) {
  if (results.length === 0 || !list) return
  active = (active + delta + results.length) % results.length
  for (const a of list.querySelectorAll<HTMLAnchorElement>("a[data-index]")) {
    const on = Number(a.dataset.index) === active
    a.setAttribute("aria-selected", String(on))
    if (on) a.scrollIntoView({ block: "nearest" })
  }
  input?.setAttribute("aria-activedescendant", `pal-${active}`)
}

input?.addEventListener("input", () => {
  active = 0
  render(input.value)
})

input?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault()
    move(1)
  } else if (event.key === "ArrowUp") {
    event.preventDefault()
    move(-1)
  } else if (event.key === "Enter") {
    const target = results[active]
    if (target) {
      event.preventDefault()
      location.href = target.href
    }
  }
})

list?.addEventListener("pointermove", (event) => {
  const a = (event.target as Element).closest<HTMLAnchorElement>("a[data-index]")
  if (!a || Number(a.dataset.index) === active) return
  move(Number(a.dataset.index) - active)
})

dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close()
})

export async function open() {
  if (!dialog || !input) return
  if (!dialog.open) dialog.showModal()
  input.value = ""
  active = 0
  await load()
  render("")
  input.focus()
}
