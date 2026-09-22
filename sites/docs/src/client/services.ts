import { score, terms } from "../lib/search.ts"
import { KEYS, store } from "./storage.ts"

// The URL owns shareable state (query, category, filters, sort); localStorage owns the view preference.
const grid = document.querySelector<HTMLElement>("[data-grid]")
const q = document.querySelector<HTMLInputElement>("[data-q]")
const browser = document.querySelector<HTMLInputElement>("[data-browser]")
const sort = document.querySelector<HTMLSelectElement>("[data-sort]")
const count = document.querySelector<HTMLElement>("[data-count]")
const empty = document.querySelector<HTMLElement>("[data-empty]")
const chips = [...document.querySelectorAll<HTMLButtonElement>("[data-cat]")]
const tierButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-tier-filter]")]
const views = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")].filter(
  (b) => b.tagName === "BUTTON",
)

if (grid && q && browser && sort && count && empty) {
  const cards = [...grid.querySelectorAll<HTMLElement>("[data-service]")].map((el) => ({
    el,
    name: el.dataset.service ?? "",
    displayName: el.dataset.display ?? "",
    category: el.dataset.category ?? "",
    browser: el.dataset.browser === "1",
    tier: el.dataset.tier ?? "",
    ops: Number(el.dataset.ops ?? 0),
    text: el.dataset.search ?? "",
  }))
  const total = cards.length
  const params = new URLSearchParams(location.search)
  let category = params.get("category") ?? ""
  let tier = params.get("tier") ?? ""
  q.value = params.get("q") ?? ""
  browser.checked = params.get("browser") === "1"
  const sortParam = params.get("sort")
  if (sortParam && [...sort.options].some((o) => o.value === sortParam)) sort.value = sortParam

  const setCategory = (slug: string) => {
    category = chips.some((c) => c.dataset.cat === slug) ? slug : ""
    for (const chip of chips)
      chip.setAttribute("aria-checked", String(chip.dataset.cat === category))
  }

  const setTier = (value: string) => {
    tier = tierButtons.some((b) => b.dataset.tierFilter === value) ? value : ""
    for (const b of tierButtons)
      b.setAttribute("aria-checked", String(b.dataset.tierFilter === tier))
  }

  const setView = (view: string) => {
    grid.dataset.view = view === "list" ? "list" : "grid"
    for (const b of views)
      b.setAttribute("aria-pressed", String(b.dataset.view === grid.dataset.view))
  }

  let urlTimer: ReturnType<typeof setTimeout> | undefined
  const syncUrl = () => {
    clearTimeout(urlTimer)
    urlTimer = setTimeout(() => {
      const next = new URLSearchParams()
      if (q.value.trim()) next.set("q", q.value.trim())
      if (tier) next.set("tier", tier)
      if (category) next.set("category", category)
      if (browser.checked) next.set("browser", "1")
      if (sort.value !== "relevance") next.set("sort", sort.value)
      const qs = next.toString()
      history.replaceState(null, "", qs ? `?${qs}` : location.pathname)
    }, 150)
  }

  const apply = () => {
    const query = terms(q.value)
    const visible = cards
      .map((card) => ({ card, rank: score(query, card) }))
      .filter(
        (r): r is { card: (typeof cards)[number]; rank: number } =>
          r.rank !== null &&
          (!category || r.card.category === category) &&
          (!tier || r.card.tier === tier) &&
          (!browser.checked || r.card.browser),
      )
    const by = sort.value === "relevance" && query.length === 0 ? "name" : sort.value
    const tierRank = (t: string) => (t === "ready" ? 0 : 1)
    visible.sort((a, b) => {
      if (by === "relevance" && a.rank !== b.rank) return a.rank - b.rank
      if (by === "name" && a.card.tier !== b.card.tier)
        return tierRank(a.card.tier) - tierRank(b.card.tier)
      if (by === "ops" && a.card.ops !== b.card.ops) return b.card.ops - a.card.ops
      if (by === "category" && a.card.category !== b.card.category)
        return a.card.category.localeCompare(b.card.category)
      return a.card.displayName.localeCompare(b.card.displayName)
    })
    const shown = new Set(visible.map((v) => v.card))
    for (const card of cards) card.el.hidden = !shown.has(card)
    grid.append(
      ...visible.map((v) => v.card.el),
      ...cards.filter((c) => !shown.has(c)).map((c) => c.el),
    )
    count.textContent =
      shown.size === total ? `${total} services` : `${shown.size} of ${total} services`
    empty.hidden = shown.size > 0
    grid.hidden = shown.size === 0
    syncUrl()
  }

  setCategory(category)
  setTier(tier)
  setView(store.get(KEYS.servicesView) ?? "grid")
  apply()

  q.addEventListener("input", apply)
  browser.addEventListener("change", apply)
  sort.addEventListener("change", apply)
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      setCategory(chip.dataset.cat ?? "")
      apply()
    })
  }
  for (const b of tierButtons) {
    b.addEventListener("click", () => {
      setTier(b.dataset.tierFilter ?? "")
      apply()
    })
  }
  for (const b of views) {
    b.addEventListener("click", () => {
      setView(b.dataset.view ?? "grid")
      store.set(KEYS.servicesView, grid.dataset.view ?? "grid")
    })
  }
  document.querySelector("[data-clear]")?.addEventListener("click", () => {
    q.value = ""
    browser.checked = false
    sort.value = "relevance"
    setCategory("")
    setTier("")
    apply()
    q.focus()
  })

  document.addEventListener("keydown", (event) => {
    const t = event.target as HTMLElement
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
    if (event.key === "/" && !typing) {
      event.preventDefault()
      q.focus()
      q.select()
    } else if (event.key === "Escape" && t === q) {
      q.value = ""
      apply()
    } else if (event.key === "Enter" && t === q) {
      const first = grid.querySelector<HTMLAnchorElement>("[data-service]:not([hidden])")
      if (first) location.href = first.href
    }
  })
}
