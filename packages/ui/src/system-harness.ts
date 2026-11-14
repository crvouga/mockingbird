/// <reference lib="dom" />

/** Product code supplies lazy surfaces; the shell knows nothing about their services. */
export type SystemSurface = {
  id: string
  label: string
  mount(host: HTMLElement, signal: AbortSignal): Promise<() => void> | (() => void)
}
export type SystemHarness = {
  show(id: string): Promise<void>
  active(): string
  destroy(): void
}

/**
 * One visible surface, with mounted surfaces retained while hidden. Resolving mount means ready;
 * rejecting means failed. Abort and late disposal make teardown safe during asynchronous loading.
 * The reserved System surface is always reachable. URL state is opt-in for embedded hosts.
 */
export function mountSystemHarness(
  host: HTMLElement,
  surfaces: readonly SystemSurface[],
  options: { initial?: string; syncUrl?: boolean } = {},
): SystemHarness {
  const ids = new Set(["system"])
  for (const surface of surfaces) {
    if (!surface.id || ids.has(surface.id))
      throw new Error(`Duplicate or reserved surface: ${surface.id}`)
    ids.add(surface.id)
  }
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  const shell = doc.createElement("div")
  shell.className = "msh"
  const style = doc.createElement("style")
  style.textContent = `
.msh{position:relative;height:100%;min-height:240px;isolation:isolate;color:CanvasText;background:Canvas;font:14px system-ui}
.msh-panel{height:100%;overflow:auto}.msh [hidden]{display:none!important}
.msh-chrome{position:absolute;inset:0;pointer-events:none;z-index:1000}
.msh-handle{position:absolute;pointer-events:auto;touch-action:none;width:44px;height:44px;border-radius:50%;border:1px solid #777;background:#17212f;color:white;box-shadow:0 2px 12px #0004;cursor:grab;font:20px system-ui}
.msh-menu{position:absolute;right:12px;bottom:64px;max-height:70%;overflow:auto;width:min(280px,calc(100% - 24px));padding:8px;border:1px solid #888;border-radius:12px;background:Canvas;box-shadow:0 4px 20px #0004;pointer-events:auto}
.msh-menu button,.msh-home button,.msh-status button{display:block;padding:12px;width:100%;text-align:left;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.msh-menu button:hover,.msh-menu button:focus-visible,.msh-home button:hover{background:#8883}
.msh-menu button[aria-current=true]{font-weight:bold;background:#8882}
.msh-home,.msh-status{max-width:640px;padding:32px;margin:auto}
.msh :focus-visible{outline:2px solid #477bff;outline-offset:2px}
`
  const chrome = doc.createElement("div")
  chrome.className = "msh-chrome"
  const handle = doc.createElement("button")
  handle.type = "button"
  handle.className = "msh-handle"
  handle.textContent = "▦"
  handle.setAttribute("aria-label", "Switch apps")
  handle.setAttribute("aria-expanded", "false")
  handle.dataset.testid = "system-switcher"
  handle.hidden = surfaces.length === 0
  const menu = doc.createElement("nav")
  menu.className = "msh-menu"
  menu.setAttribute("aria-label", "System apps")
  menu.hidden = true
  chrome.append(menu, handle)
  shell.append(style, chrome)
  host.append(shell)
  let destroyed = false
  let current = ""
  const controller = new AbortController()
  type Entry = {
    spec: SystemSurface
    panel: HTMLElement
    button: HTMLButtonElement
    pending?: Promise<void> | undefined
    dispose?: (() => void) | undefined
  }
  const entries: Entry[] = []
  const closeMenu = () => {
    menu.hidden = true
    handle.setAttribute("aria-expanded", "false")
  }
  const all: SystemSurface[] = [
    {
      id: "system",
      label: "System",
      mount(panel) {
        const home = doc.createElement("div")
        home.className = "msh-home"
        const heading = doc.createElement("h1")
        heading.textContent = "System"
        const intro = doc.createElement("p")
        intro.textContent =
          "Your whole system, running in this browser. Open an app or inspect the services behind it."
        home.append(heading, intro)
        for (const surface of surfaces) {
          const button = doc.createElement("button")
          button.textContent = surface.label
          button.onclick = () => {
            void show(surface.id)
          }
          home.append(button)
        }
        panel.append(home)
        return () => home.remove()
      },
    },
    ...surfaces,
  ]
  for (const spec of all) {
    const panel = doc.createElement("section")
    panel.className = "msh-panel"
    panel.dataset.surface = spec.id
    panel.setAttribute("aria-label", spec.label)
    panel.tabIndex = -1
    panel.hidden = true
    const button = doc.createElement("button")
    button.type = "button"
    button.textContent = spec.label
    button.dataset.surface = spec.id
    button.onclick = () => {
      void show(spec.id)
      entries.find((e) => e.spec.id === spec.id)?.panel.focus()
    }
    menu.append(button)
    shell.insertBefore(panel, chrome)
    entries.push({ spec, panel, button })
  }
  function load(entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending
    entry.panel.setAttribute("aria-busy", "true")
    const status = doc.createElement("div")
    status.className = "msh-status"
    status.setAttribute("role", "status")
    status.textContent = "Loading…"
    const content = doc.createElement("div")
    content.style.height = "100%"
    entry.panel.replaceChildren(status, content)
    entry.pending = Promise.resolve()
      .then(() => {
        if (destroyed) return
        return entry.spec.mount(content, controller.signal)
      })
      .then((dispose) => {
        status.remove()
        if (destroyed) dispose?.()
        else entry.dispose = dispose
      })
      .catch((error: unknown) => {
        if (destroyed) return
        content.remove()
        status.textContent = `Unable to open ${entry.spec.label}: ${error instanceof Error ? error.message : String(error)}`
        const retry = doc.createElement("button")
        retry.textContent = "Retry"
        retry.onclick = () => {
          entry.pending = undefined
          void load(entry)
        }
        status.append(retry)
      })
      .finally(() => entry.panel.removeAttribute("aria-busy"))
    return entry.pending
  }
  async function show(id: string): Promise<void> {
    if (destroyed) return
    const entry = entries.find((e) => e.spec.id === id) ?? entries[0]
    if (!entry) return
    current = entry.spec.id
    for (const candidate of entries) {
      candidate.panel.hidden = candidate !== entry
      candidate.panel.inert = candidate !== entry
      candidate.button.setAttribute("aria-current", String(candidate === entry))
    }
    closeMenu()
    if (
      entries.some(
        (candidate) => candidate.panel.hidden && candidate.panel.contains(doc.activeElement),
      )
    ) {
      entry.panel.focus()
    }
    if (options.syncUrl) {
      const url = new URL(win.location.href)
      url.searchParams.set("surface", current)
      if (url.href !== win.location.href) win.history.pushState(null, "", url)
    }
    await load(entry)
  }
  handle.onclick = () => {
    if (dragged) {
      dragged = false
      return
    }
    menu.hidden = !menu.hidden
    handle.setAttribute("aria-expanded", String(!menu.hidden))
    if (!menu.hidden) entries.find((e) => e.spec.id === current)?.button.focus()
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation()
      event.preventDefault()
      closeMenu()
      handle.focus()
    }
  }
  shell.addEventListener("keydown", key)
  let x = Infinity
  let y = Infinity
  const position = () => {
    x = Math.max(0, Math.min(x, shell.clientWidth - 52))
    y = Math.max(0, Math.min(y, shell.clientHeight - 52))
    handle.style.left = `${x}px`
    handle.style.top = `${y}px`
    const below = y < shell.clientHeight / 2
    menu.style.top = below ? `${y + 48}px` : "auto"
    menu.style.bottom = below ? "auto" : `${Math.max(8, shell.clientHeight - y)}px`
    menu.style.maxHeight = `${Math.max(80, below ? shell.clientHeight - y - 56 : y - 8)}px`
  }
  let drag: { x: number; y: number; left: number; top: number } | undefined
  let dragged = false
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return
    dragged = false
    drag = { x: event.clientX, y: event.clientY, left: x, top: y }
    handle.setPointerCapture(event.pointerId)
  }
  handle.onpointermove = (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) > 5) dragged = true
    if (!dragged) return
    x = drag.left + dx
    y = drag.top + dy
    position()
  }
  handle.onpointerup = () => {
    drag = undefined
  }
  handle.onpointercancel = () => {
    drag = undefined
    dragged = false
  }
  handle.onlostpointercapture = () => {
    drag = undefined
  }
  const resize = new ResizeObserver(position)
  resize.observe(shell)
  const fromUrl = () =>
    new URL(win.location.href).searchParams.get("surface") ?? options.initial ?? "system"
  const pop = () => {
    void show(fromUrl())
  }
  if (options.syncUrl) win.addEventListener("popstate", pop)
  void show(options.syncUrl ? fromUrl() : (options.initial ?? "system"))
  return {
    show,
    active: () => current,
    destroy() {
      if (destroyed) return
      destroyed = true
      controller.abort()
      resize.disconnect()
      win.removeEventListener("popstate", pop)
      for (const entry of entries) {
        try {
          entry.dispose?.()
        } catch {
          /* Other surfaces must still be disposed. */
        }
      }
      shell.remove()
    },
  }
}
