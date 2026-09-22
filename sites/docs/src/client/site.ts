import { KEYS, store } from "./storage.ts"

const root = document.documentElement
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// Theme: explicit choice persists; otherwise follow the OS live.
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
  button.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark"
    root.dataset.theme = next
    store.set(KEYS.theme, next)
  })
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!store.get(KEYS.theme)) root.dataset.theme = e.matches ? "dark" : "light"
})

// Header gains a border once the page scrolls.
const header = document.querySelector<HTMLElement>("[data-header]")
if (header) {
  const update = () => header.toggleAttribute("data-scrolled", window.scrollY > 4)
  update()
  addEventListener("scroll", update, { passive: true })
}

if (!isMac) {
  for (const kbd of document.querySelectorAll("[data-mod-key]")) kbd.textContent = "Ctrl K"
  for (const kbd of document.querySelectorAll("[data-mod-enter]")) kbd.textContent = "Ctrl ↵"
}

// Copy buttons: `data-copy="text"`, or the nearest code block's text.
document.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy]")
  if (!button) return
  const text =
    button.dataset.copy ||
    button.closest(".code, .cmd, [data-copy-scope]")?.querySelector("pre, code")?.textContent ||
    ""
  try {
    await navigator.clipboard.writeText(text.replace(/\n$/, ""))
    button.setAttribute("data-copied", "")
    button.setAttribute("aria-label", "Copied")
    setTimeout(() => {
      button.removeAttribute("data-copied")
      button.setAttribute("aria-label", "Copy")
    }, 1600)
  } catch {
    // Clipboard blocked (insecure context); the text stays selectable.
  }
})

// Package-manager tabs: one choice, remembered, applied to every install block on every page.
const selectPm = (pm: string) => {
  for (const tab of document.querySelectorAll<HTMLElement>("[data-pm]")) {
    const on = tab.dataset.pm === pm
    tab.setAttribute("aria-selected", String(on))
    tab.tabIndex = on ? 0 : -1
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-pm-panel]")) {
    panel.hidden = panel.dataset.pmPanel !== pm
  }
}
if (document.querySelector("[data-pm]")) {
  selectPm(store.get(KEYS.packageManager) ?? "npm")
  document.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLElement>("[data-pm]")
    if (!tab?.dataset.pm) return
    selectPm(tab.dataset.pm)
    store.set(KEYS.packageManager, tab.dataset.pm)
  })
  document.addEventListener("keydown", (event) => {
    const tab = (event.target as Element).closest<HTMLElement>("[data-pm]")
    if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return
    const tabs = [...(tab.parentElement?.querySelectorAll<HTMLElement>("[data-pm]") ?? [])]
    const next =
      tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]
    if (!next?.dataset.pm) return
    selectPm(next.dataset.pm)
    store.set(KEYS.packageManager, next.dataset.pm)
    next.focus()
  })
}

// Command palette: loaded on first use, warmed on hover.
let palette: Promise<typeof import("./palette.ts")> | undefined
const loadPalette = () => {
  palette ??= import("./palette.ts")
  return palette
}
const openPalette = async () => (await loadPalette()).open()

for (const trigger of document.querySelectorAll("[data-palette-open]")) {
  trigger.addEventListener("click", openPalette)
  trigger.addEventListener("pointerenter", loadPalette, { once: true })
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault()
    void openPalette()
  } else if (
    event.key === "/" &&
    !typing(event.target) &&
    !document.querySelector("[data-local-search]")
  ) {
    event.preventDefault()
    void openPalette()
  }
})
