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
 * The switcher pill docks to the middle of the left edge until dragged; the edge and the
 * position along it are kept in localStorage, so it returns there after a reload or resize.
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
.msh-switcher{position:absolute;pointer-events:auto;touch-action:none;display:flex;align-items:center;gap:2px;padding:3px;border-radius:999px;border:1px solid #ffffff2e;background:#17212f;color:white;box-shadow:0 4px 16px #0005;cursor:grab;user-select:none}
.msh-switcher.msh-dragging{cursor:grabbing}
.msh-switcher button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer}
.msh-switcher button:hover{background:#ffffff1f}
.msh-switcher button:active{background:#ffffff33}
.msh-switcher.msh-dragging button{cursor:grabbing;background:transparent}
.msh-switcher hr{width:1px;height:20px;margin:0;border:0;background:#ffffff2e}
.msh-switcher svg{width:18px;height:18px;pointer-events:none}
.msh-tip{position:absolute;pointer-events:none;padding:5px 9px;border-radius:6px;background:#0b1220;color:white;font:12px/1.3 system-ui;white-space:nowrap;box-shadow:0 2px 10px #0006}
.msh-home button,.msh-status button{display:block;padding:12px;width:100%;text-align:left;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.msh-home button:hover{background:#8883}
.msh-home,.msh-status{max-width:640px;padding:32px;margin:auto}
.msh :focus-visible{outline:2px solid #477bff;outline-offset:2px}
`
  const chrome = doc.createElement("div")
  chrome.className = "msh-chrome"
  const switcher = doc.createElement("div")
  switcher.className = "msh-switcher"
  switcher.setAttribute("role", "group")
  switcher.setAttribute("aria-label", "Switch apps")
  switcher.dataset.testid = "system-switcher"
  switcher.hidden = surfaces.length === 0
  const arrow = (direction: "previous" | "next") => {
    const button = doc.createElement("button")
    button.type = "button"
    button.setAttribute("aria-label", direction === "next" ? "Next app" : "Previous app")
    button.dataset.testid = `system-switcher-${direction}`
    const path = direction === "next" ? "M5 12h14M13 6l6 6-6 6" : "M19 12H5M11 6l-6 6 6 6"
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
    return button
  }
  const previousButton = arrow("previous")
  const nextButton = arrow("next")
  switcher.append(previousButton, doc.createElement("hr"), nextButton)
  const tip = doc.createElement("div")
  tip.className = "msh-tip"
  tip.setAttribute("role", "tooltip")
  tip.hidden = true
  chrome.append(switcher, tip)
  shell.append(style, chrome)
  host.append(shell)
  let destroyed = false
  let current = ""
  const controller = new AbortController()
  type Entry = {
    spec: SystemSurface
    panel: HTMLElement
    pending?: Promise<void> | undefined
    dispose?: (() => void) | undefined
  }
  const entries: Entry[] = []
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
    shell.insertBefore(panel, chrome)
    entries.push({ spec, panel })
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
    for (const [button, step] of [
      [previousButton, -1],
      [nextButton, 1],
    ] as const) {
      const label = `${step < 0 ? "Previous" : "Next"}: ${neighbour(step).spec.label}`
      button.dataset.tip = label
      button.setAttribute("aria-description", label)
    }
    if (tipFor) showTip(tipFor)
    for (const candidate of entries) {
      candidate.panel.hidden = candidate !== entry
      candidate.panel.inert = candidate !== entry
    }
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
  function neighbour(step: -1 | 1): Entry {
    const index = entries.findIndex((entry) => entry.spec.id === current)
    return entries[(index + step + entries.length) % entries.length] ?? (entries[0] as Entry)
  }
  let tipFor: HTMLButtonElement | undefined
  function showTip(button: HTMLButtonElement) {
    tipFor = button
    tip.textContent = button.dataset.tip ?? ""
    tip.hidden = false
    const box = shell.getBoundingClientRect()
    const target = button.getBoundingClientRect()
    const pill = switcher.getBoundingClientRect()
    const left = target.left - box.left + (target.width - tip.offsetWidth) / 2
    const above = pill.top - box.top - tip.offsetHeight - 8
    tip.style.left = `${Math.max(4, Math.min(left, shell.clientWidth - tip.offsetWidth - 4))}px`
    tip.style.top = `${above >= 4 ? above : pill.bottom - box.top + 8}px`
  }
  const hideTip = () => {
    tipFor = undefined
    tip.hidden = true
  }
  for (const [button, step] of [
    [previousButton, -1],
    [nextButton, 1],
  ] as const) {
    button.onclick = () => {
      if (dragged) return
      void show(neighbour(step).spec.id)
    }
    button.onpointerenter = (event) => {
      if (event.pointerType === "mouse" && !drag) showTip(button)
    }
    button.onpointerleave = () => {
      if (tipFor === button) hideTip()
    }
    button.onfocus = () => {
      if (button.matches(":focus-visible")) showTip(button)
    }
    button.onblur = () => {
      if (tipFor === button) hideTip()
    }
  }
  switcher.onkeydown = (event) => {
    if (event.key === "Escape") hideTip()
  }

  // Where the pill rests: an edge, and how far along it (0 = start, 1 = end).
  type Dock = { edge: "left" | "right" | "top" | "bottom"; at: number }
  const DOCK_KEY = "mockingbird.system-switcher.dock"
  const MARGIN = 8
  const readDock = (): Dock => {
    try {
      const saved = JSON.parse(win.localStorage.getItem(DOCK_KEY) ?? "null") as Partial<Dock>
      if (
        saved &&
        ["left", "right", "top", "bottom"].includes(saved.edge ?? "") &&
        typeof saved.at === "number" &&
        saved.at >= 0 &&
        saved.at <= 1
      )
        return saved as Dock
    } catch {
      /* Storage can be unavailable or hold something else; fall back to the default. */
    }
    return { edge: "left", at: 0.5 }
  }
  const writeDock = (value: Dock) => {
    try {
      win.localStorage.setItem(DOCK_KEY, JSON.stringify(value))
    } catch {
      /* The position is a convenience; switching still works without storage. */
    }
  }
  let dock = readDock()
  let x = 0
  let y = 0
  const limits = () => {
    const maxX = Math.max(0, shell.clientWidth - switcher.offsetWidth - MARGIN)
    const maxY = Math.max(0, shell.clientHeight - switcher.offsetHeight - MARGIN)
    return { minX: Math.min(MARGIN, maxX), minY: Math.min(MARGIN, maxY), maxX, maxY }
  }
  const position = () => {
    const { maxX, maxY } = limits()
    x = Math.max(0, Math.min(x, maxX + MARGIN))
    y = Math.max(0, Math.min(y, maxY + MARGIN))
    switcher.style.left = `${x}px`
    switcher.style.top = `${y}px`
  }
  const settle = () => {
    const { minX, minY, maxX, maxY } = limits()
    const along = (min: number, max: number) => min + (max - min) * dock.at
    x = dock.edge === "left" ? minX : dock.edge === "right" ? maxX : along(minX, maxX)
    y = dock.edge === "top" ? minY : dock.edge === "bottom" ? maxY : along(minY, maxY)
    position()
  }
  const snap = () => {
    const { minX, minY, maxX, maxY } = limits()
    x = Math.max(minX, Math.min(x, maxX))
    y = Math.max(minY, Math.min(y, maxY))
    const fraction = (value: number, min: number, max: number) =>
      max > min ? (value - min) / (max - min) : 0.5
    const distances = { left: x - minX, right: maxX - x, top: y - minY, bottom: maxY - y }
    const edge = (Object.keys(distances) as Dock["edge"][]).reduce((a, b) =>
      distances[b] < distances[a] ? b : a,
    )
    dock = {
      edge,
      at: edge === "left" || edge === "right" ? fraction(y, minY, maxY) : fraction(x, minX, maxX),
    }
    writeDock(dock)
    switcher.style.transition = win.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "none"
      : "left 160ms ease-out, top 160ms ease-out"
    settle()
  }
  let drag: { x: number; y: number; left: number; top: number } | undefined
  let dragged = false
  switcher.onpointerdown = (event) => {
    if (event.button !== 0) return
    dragged = false
    switcher.style.transition = "none"
    drag = { x: event.clientX, y: event.clientY, left: x, top: y }
  }
  switcher.onpointermove = (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!dragged && Math.hypot(dx, dy) > 5) {
      dragged = true
      hideTip()
      switcher.classList.add("msh-dragging")
      // Capture only once it is a drag, so a plain press still clicks the arrow under it.
      switcher.setPointerCapture(event.pointerId)
    }
    if (!dragged) return
    x = drag.left + dx
    y = drag.top + dy
    position()
  }
  const release = () => {
    if (!drag) return
    drag = undefined
    switcher.classList.remove("msh-dragging")
    if (dragged) {
      snap()
      // The click that ends a drag arrives after pointerup; let it through on the next task.
      win.setTimeout(() => {
        dragged = false
      })
    }
  }
  switcher.onpointerup = release
  switcher.onpointercancel = release
  switcher.onlostpointercapture = release
  const resize = new ResizeObserver(() => {
    switcher.style.transition = "none"
    settle()
  })
  resize.observe(shell)
  resize.observe(switcher)
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
