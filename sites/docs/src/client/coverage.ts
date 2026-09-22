// Sortable coverage table; the sort lives in `?sort=<key>&dir=asc|desc` so a sorted view is shareable.
const table = document.querySelector<HTMLTableElement>("[data-sortable]")
const body = table?.tBodies[0]

if (table && body) {
  const rows = [...body.rows]
  const headers = [...table.querySelectorAll<HTMLButtonElement>("[data-sort-key]")]
  const numeric = new Set(["tier", "coverage", "browser", "inprocess", "server", "cli"])

  const sortBy = (key: string, dir: "asc" | "desc") => {
    const factor = dir === "asc" ? 1 : -1
    rows.sort((a, b) => {
      const x = a.dataset[key] ?? ""
      const y = b.dataset[key] ?? ""
      const cmp = numeric.has(key) ? Number(x) - Number(y) : x.localeCompare(y)
      return cmp * factor || (a.dataset.name ?? "").localeCompare(b.dataset.name ?? "")
    })
    body.append(...rows)
    for (const h of headers) {
      const th = h.closest("th")
      if (h.dataset.sortKey === key)
        th?.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending")
      else th?.removeAttribute("aria-sort")
    }
    const url = new URL(location.href)
    url.searchParams.set("sort", key)
    url.searchParams.set("dir", dir)
    history.replaceState(null, "", url)
  }

  for (const h of headers) {
    h.addEventListener("click", () => {
      const key = h.dataset.sortKey ?? "name"
      const current = h.closest("th")?.getAttribute("aria-sort")
      const dir =
        current === "ascending"
          ? "desc"
          : current === "descending"
            ? "asc"
            : numeric.has(key)
              ? "desc"
              : "asc"
      sortBy(key, dir)
    })
  }

  const params = new URLSearchParams(location.search)
  const key = params.get("sort")
  if (key && headers.some((h) => h.dataset.sortKey === key))
    sortBy(key, params.get("dir") === "desc" ? "desc" : "asc")
}
