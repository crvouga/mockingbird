// Highlight the table-of-contents entry for the heading nearest the top of the viewport.
const links = new Map<string, HTMLAnchorElement>()
for (const a of document.querySelectorAll<HTMLAnchorElement>(".toc a[href^='#']")) {
  links.set(decodeURIComponent(a.hash.slice(1)), a)
}
const headings = [...links.keys()]
  .map((id) => document.getElementById(id))
  .filter((el): el is HTMLElement => el !== null)

if (headings.length > 0) {
  let current: HTMLAnchorElement | undefined
  const update = () => {
    const offset = 120
    let active = headings[0]
    for (const h of headings) {
      if (h.getBoundingClientRect().top - offset <= 0) active = h
      else break
    }
    const link = active ? links.get(active.id) : undefined
    if (link === current) return
    current?.removeAttribute("aria-current")
    link?.setAttribute("aria-current", "true")
    current = link
  }
  let ticking = false
  addEventListener(
    "scroll",
    () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        update()
      })
    },
    { passive: true },
  )
  update()
}
