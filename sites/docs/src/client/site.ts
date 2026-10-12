import { KEYS, store } from "./storage.ts"

const root = document.documentElement
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// Theme: system follows the OS, and it is the default until a choice is stored.
type ThemeMode = "system" | "light" | "dark"
const themeModes: ThemeMode[] = ["system", "light", "dark"]
const isThemeMode = (value: string | undefined): value is ThemeMode =>
  themeModes.includes(value as ThemeMode)
const systemTheme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")

const applyTheme = (mode: ThemeMode, persist: boolean) => {
  const theme = mode === "system" ? systemTheme() : mode
  root.dataset.theme = theme
  root.dataset.themeMode = mode
  if (persist) store.set(KEYS.theme, mode)
  for (const item of document.querySelectorAll<HTMLButtonElement>("[data-theme-mode]")) {
    item.setAttribute("aria-checked", String(item.dataset.themeMode === mode))
  }
  document.querySelector("[data-theme-toggle]")?.setAttribute("aria-label", `Theme: ${mode}`)
  const color = theme === "dark" ? "#0d1117" : "#ffffff"
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = color
  }
}

const storedMode = store.get(KEYS.theme)
applyTheme(isThemeMode(storedMode ?? undefined) ? (storedMode as ThemeMode) : "system", false)

const picker = document.querySelector<HTMLElement>("[data-theme-picker]")
const themeToggle = picker?.querySelector<HTMLButtonElement>("[data-theme-toggle]")
const themeMenu = picker?.querySelector<HTMLElement>("[data-theme-menu]")
const closeThemeMenu = () => {
  if (!themeMenu || !themeToggle) return
  themeMenu.hidden = true
  themeToggle.setAttribute("aria-expanded", "false")
}
themeToggle?.addEventListener("click", () => {
  if (!themeMenu) return
  const open = themeMenu.hidden
  themeMenu.hidden = !open
  themeToggle.setAttribute("aria-expanded", String(open))
  if (open) themeMenu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
})
themeMenu?.addEventListener("click", (event) => {
  const item = (event.target as Element).closest<HTMLButtonElement>("[data-theme-mode]")
  if (!item || !isThemeMode(item.dataset.themeMode)) return
  applyTheme(item.dataset.themeMode, true)
  closeThemeMenu()
  themeToggle?.focus()
})
themeMenu?.addEventListener("keydown", (event) => {
  const items = [...themeMenu.querySelectorAll<HTMLButtonElement>("[data-theme-mode]")]
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === "Escape") {
    event.preventDefault()
    closeThemeMenu()
    themeToggle?.focus()
    return
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  event.preventDefault()
  const next = items[(current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]
  next?.focus()
})
document.addEventListener("click", (event) => {
  if (picker && !picker.contains(event.target as Node)) closeThemeMenu()
})
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (root.dataset.themeMode === "system") applyTheme("system", false)
})

// Mobile menu: the primary nav collapses behind a toggle on narrow screens.
const header = document.querySelector<HTMLElement>("[data-header]")
const navToggle = header?.querySelector<HTMLButtonElement>("[data-nav-toggle]")
const navOpen = () => header?.hasAttribute("data-nav-open") ?? false
const setNavOpen = (open: boolean) => {
  if (!header || !navToggle) return
  header.toggleAttribute("data-nav-open", open)
  navToggle.setAttribute("aria-expanded", String(open))
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu")
}
navToggle?.addEventListener("click", () => setNavOpen(!navOpen()))
document.addEventListener("click", (event) => {
  const target = event.target as Element
  // The toggle handles itself; anything else outside the menu dismisses it.
  if (!target.closest("[data-nav-toggle], [data-nav]")) setNavOpen(false)
})
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !navOpen()) return
  setNavOpen(false)
  navToggle?.focus()
})
matchMedia("(min-width: 901px)").addEventListener("change", () => setNavOpen(false))
// A page restored from the back/forward cache comes back exactly as it was left.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) setNavOpen(false)
})

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
  if (event.defaultPrevented || document.querySelector("dialog[data-example-modal][open]")) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault()
    void openPalette()
  } else if (
    event.key === "/" &&
    !typing(event.target) &&
    !document.querySelector("[data-local-search]") &&
    // A live example owns the keyboard while its window is open.
    !document.querySelector("dialog[data-example-modal][open]")
  ) {
    event.preventDefault()
    void openPalette()
  }
})
