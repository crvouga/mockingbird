/// <reference lib="dom" />
import { paintIcon, type SystemIcon } from "./system-icons.js"
import { summarizeServices } from "./system-rotation.js"

/** Where a service's requests go: its emulator in this tab, or a real non-production resource. */
export type SystemServiceMode = "emulated" | "dev"

/** One third-party service behind the preview, and where its requests go. */
export type SystemService = {
  id: string
  label: string
  category?: string
  mode: SystemServiceMode
  /** Why dev cannot be chosen (for example, the proxy blocked it); undefined when it can. */
  unavailable?: string
}

/**
 * Whether this preview can reach the dev proxy, in one sentence. The proxy runs on the app's own
 * origin and adds the credentials server-side, so the browser never sees a credential.
 */
export type SystemDevStatus = {
  state: "ready" | "unreachable" | "none"
  /** One sentence shown in the access panel. */
  message: string
  /** The proxy URL, displayed. */
  endpoint?: string
}

/** What the System screen lists and switches. `@crvouga/mockingbird-preview`'s `controls()` is one. */
export type SystemServices = {
  list(): Promise<{ dev: SystemDevStatus; services: readonly SystemService[] }>
  setMode(id: string, mode: SystemServiceMode): Promise<void>
}

/** What the harness hands the System screen. */
export type SystemScreenContext = {
  /** Every surface, System included, in the order the switcher's arrows go through them. */
  apps: readonly {
    id: string
    label: string
    description?: string | undefined
    icon?: SystemIcon | undefined
  }[]
  open(id: string): void
  inRotation(id: string): boolean
  setInRotation(id: string, included: boolean): void
  /** The person reordered the list. */
  setOrder(ids: readonly string[]): void
  services?: SystemServices | undefined
  docsUrl?: string | undefined
}

const ICONS = {
  open: '<path d="M7 17 17 7M8 7h9v9"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert:
    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  shield:
    '<path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4"/>',
} as const
const icon = (name: keyof typeof ICONS) =>
  `<svg class="msh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`

const STATES: Record<SystemDevStatus["state"], { chip: string; hint: string }> = {
  ready: {
    chip: "Ready",
    hint: "It runs on this app's own origin and adds the credentials itself.",
  },
  unreachable: {
    chip: "Unreachable",
    hint: "Check that the proxy is running on this app's origin, then refresh.",
  },
  none: {
    chip: "Not set up",
    hint: "Every service is emulated in this tab. Deploy the dev proxy and give its URL to this preview to reach non-production resources.",
  },
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Draws the System screen into `panel`; returns its disposer. */
export function mountSystemScreen(panel: HTMLElement, context: SystemScreenContext): () => void {
  const doc = panel.ownerDocument
  let disposed = false
  let uid = 0
  const id = (name: string) => `msh-${name}-${++uid}-${Math.random().toString(36).slice(2, 7)}`
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const button = (className: string, label: string, iconName?: keyof typeof ICONS) => {
    const node = el("button", `msh-btn ${className}`)
    node.type = "button"
    node.innerHTML = iconName ? icon(iconName) : ""
    node.append(el("span", "", label))
    return node
  }

  const home = el("div", "msh-home")
  const page = el("div", "msh-page")
  home.append(page)

  // ---- header
  const header = el("header", "msh-header")
  const titles = el("div", "msh-titles")
  titles.append(
    el("p", "msh-eyebrow", "Mockingbird preview"),
    el("h1", "msh-title", "System"),
    el("p", "msh-subtitle", "Everything this preview runs, in this browser tab."),
  )
  header.append(titles)
  if (context.docsUrl) {
    const docs = el("a", "msh-docs")
    docs.href = context.docsUrl
    docs.target = "_blank"
    docs.rel = "noreferrer"
    docs.append(el("span", "", "How dev resources work"))
    docs.insertAdjacentHTML("beforeend", icon("external"))
    header.append(docs)
  }
  page.append(header)

  // ---- apps
  const apps = el("section", "msh-section")
  const appsHeading = el("h2", "msh-h2", "Apps")
  appsHeading.id = id("apps")
  apps.setAttribute("aria-labelledby", appsHeading.id)
  const appsMeta = el("p", "msh-meta")
  const appsHead = el("div", "msh-section-head")
  const appsTitles = el("div")
  appsTitles.append(appsHeading, appsMeta)
  appsHead.append(appsTitles)
  apps.append(appsHead)
  const surfaces = context.apps.filter((app) => app.id !== "system")
  const paintAppsMeta = () => {
    const included = surfaces.filter((app) => context.inRotation(app.id)).length
    appsMeta.textContent =
      surfaces.length === 0
        ? "This preview has no apps yet."
        : `${surfaces.length} ${surfaces.length === 1 ? "app" : "apps"} · ${included} in the switcher. The arrows go down this list, skipping the ones you switch off. Drag to reorder.`
  }
  paintAppsMeta()
  if (surfaces.length > 0) {
    const list = el("ol", "msh-apps")
    list.setAttribute("aria-label", "Switcher order")
    const hint = el("p", "msh-sr", "Drag to reorder, or use the arrow keys, Home and End.")
    hint.id = id("reorder-hint")
    const announce = el("p", "msh-sr")
    announce.setAttribute("role", "status")
    apps.append(hint, announce)

    const ids = () => [...list.children].map((row) => (row as HTMLElement).dataset.app as string)
    const labelOf = (appId: string) => context.apps.find((app) => app.id === appId)?.label ?? appId
    const commit = (moved: string) => {
      const order = ids()
      context.setOrder(order)
      announce.textContent = `${labelOf(moved)} moved to position ${order.indexOf(moved) + 1} of ${order.length}.`
    }
    /** Slides `row` from where it was drawn to where it now is (FLIP), unless motion is reduced. */
    const slide = (row: HTMLElement, fromTop: number) => {
      const delta = fromTop - row.offsetTop
      if (!delta || doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) return
      row.style.transition = "none"
      row.style.transform = `translateY(${delta}px)`
      void row.offsetHeight
      row.style.transition = "transform .16s ease-out"
      row.style.transform = ""
    }

    for (const app of context.apps) {
      const fixed = app.id === "system"
      const row = el("li", "msh-card msh-row")
      row.dataset.app = app.id

      const grip = el("button", "msh-grip")
      grip.type = "button"
      grip.innerHTML = icon("grip")
      grip.setAttribute("aria-label", `Reorder ${app.label}`)
      grip.setAttribute("aria-describedby", hint.id)

      const mark = el("span", "msh-mark")
      mark.setAttribute("aria-hidden", "true")
      paintIcon(mark, app.icon, app.label)
      const text = el("span", "msh-app-text")
      text.append(el("span", "msh-app-label", app.label))
      if (app.description) text.append(el("span", "msh-app-desc", app.description))

      // The whole row body is the switch: one click anywhere on it turns the app on or off.
      let main: HTMLElement
      if (fixed) {
        main = el("div", "msh-row-main msh-row-fixed")
        main.append(mark, text, el("span", "msh-always", "Always on"))
      } else {
        const toggle = el("button", "msh-switch msh-row-main")
        toggle.type = "button"
        toggle.setAttribute("role", "switch")
        toggle.setAttribute("aria-label", `${app.label} in switcher`)
        toggle.innerHTML =
          '<span class="msh-track" aria-hidden="true"><span class="msh-thumb"></span></span>'
        toggle.append(mark, text)
        const paint = () => toggle.setAttribute("aria-checked", String(context.inRotation(app.id)))
        paint()
        toggle.onclick = () => {
          context.setInRotation(app.id, !context.inRotation(app.id))
          paint()
          paintAppsMeta()
        }
        main = toggle
      }

      const open = button("msh-btn-secondary msh-open", "Open", "open")
      open.setAttribute("aria-label", `Open ${app.label}`)
      // Icon after the text reads better for "Open ↗".
      open.append(open.querySelector("svg") as SVGElement)
      open.onclick = () => context.open(app.id)

      // Keyboard: the grip moves its row.
      grip.onkeydown = (event) => {
        const order = ids()
        const from = order.indexOf(app.id)
        const to =
          event.key === "ArrowUp"
            ? from - 1
            : event.key === "ArrowDown"
              ? from + 1
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? order.length - 1
                  : undefined
        if (to === undefined) return
        event.preventDefault()
        if (to < 0 || to >= order.length || to === from) return
        const tops = new Map([...list.children].map((r) => [r, (r as HTMLElement).offsetTop]))
        const reference = list.children[to > from ? to + 1 : to] ?? null
        list.insertBefore(row, reference)
        for (const [r, top] of tops) slide(r as HTMLElement, top)
        grip.focus()
        commit(app.id)
      }

      // Pointer: drag the grip; the row follows and the others make room as it passes them.
      let drag: { y: number; from: number } | undefined
      grip.onpointerdown = (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        try {
          grip.setPointerCapture(event.pointerId)
        } catch {
          /* A synthetic pointer has nothing to capture; moves still reach the grip. */
        }
        drag = { y: event.clientY, from: ids().indexOf(app.id) }
        row.style.transition = "none"
        row.classList.add("msh-row-dragging")
      }
      grip.onpointermove = (event) => {
        if (!drag) return
        const center = () => row.offsetTop + row.offsetHeight / 2 + (event.clientY - (drag?.y ?? 0))
        for (;;) {
          const next = row.nextElementSibling as HTMLElement | null
          const previous = row.previousElementSibling as HTMLElement | null
          const before = row.offsetTop
          let passed: HTMLElement | undefined
          if (next && center() > next.offsetTop + next.offsetHeight / 2) passed = next
          else if (previous && center() < previous.offsetTop + previous.offsetHeight / 2)
            passed = previous
          if (!passed) break
          const passedTop = passed.offsetTop
          // Always move the neighbour: moving the dragged row's own node would release its
          // pointer capture and end the drag.
          if (passed === next) list.insertBefore(passed, row)
          else list.insertBefore(passed, row.nextSibling)
          slide(passed, passedTop)
          // Keep the row under the pointer now that its slot moved.
          drag.y += row.offsetTop - before
        }
        const min = -row.offsetTop
        const max = list.clientHeight - row.offsetTop - row.offsetHeight
        const dy = Math.max(min, Math.min(max, event.clientY - drag.y))
        row.style.transform = `translateY(${dy}px)`
      }
      const drop = () => {
        if (!drag) return
        const { from } = drag
        drag = undefined
        row.classList.remove("msh-row-dragging")
        slide(row, row.offsetTop + (Number.parseFloat(row.style.transform.slice(11)) || 0))
        row.style.transform = ""
        if (ids().indexOf(app.id) !== from) commit(app.id)
      }
      grip.onpointerup = drop
      grip.onpointercancel = drop
      grip.onlostpointercapture = drop

      row.append(grip, main, open)
      list.append(row)
    }
    apps.append(list)
  }
  page.append(apps)

  // ---- services + dev access
  const services = context.services
  const lower = el("div", services ? "msh-lower" : "msh-lower msh-lower-single")
  page.append(lower)

  const servicesSection = el("section", "msh-section msh-services")
  const servicesHeading = el("h2", "msh-h2", "Services")
  servicesHeading.id = id("services")
  servicesSection.setAttribute("aria-labelledby", servicesHeading.id)
  const servicesHead = el("div", "msh-section-head")
  const servicesTitles = el("div")
  const description = el(
    "p",
    "msh-meta",
    "Third-party services the apps call. Each runs emulated in this tab, or against a real non-production resource through the dev proxy.",
  )
  const summary = el("p", "msh-meta msh-summary")
  summary.dataset.testid = "system-services-summary"
  servicesTitles.append(servicesHeading, description, summary)
  servicesHead.append(servicesTitles)
  servicesSection.append(servicesHead)

  if (!services) {
    summary.hidden = true
    const empty = el("div", "msh-card msh-empty")
    empty.innerHTML = icon("plug")
    const emptyText = el("div")
    emptyText.append(
      el("p", "msh-empty-title", "No services listed"),
      el(
        "p",
        "msh-empty-body",
        "The host app supplies them. When it passes its services to the harness, each emulator appears here and can switch between running in this tab and a real non-production resource.",
      ),
    )
    empty.append(emptyText)
    servicesSection.append(empty)
    lower.append(servicesSection)
    panel.append(home)
    return () => {
      disposed = true
      home.remove()
    }
  }

  // Dev proxy status card: read-only, since the proxy holds the credentials.
  const access = el("section", "msh-card msh-access")
  const accessHeading = el("h2", "msh-access-title", "Dev proxy")
  accessHeading.id = id("access")
  access.setAttribute("aria-labelledby", accessHeading.id)
  access.dataset.testid = "system-dev-proxy"
  const accessHead = el("div", "msh-access-head")
  const dot = el("span", "msh-dot")
  dot.setAttribute("aria-hidden", "true")
  const chip = el("span", "msh-chip")
  accessHead.append(dot, accessHeading, chip)
  const accessMessage = el("p", "msh-access-msg")
  const accessHint = el("p", "msh-access-hint")
  const safety = el("p", "msh-safety")
  safety.innerHTML = icon("shield")
  safety.append(
    el(
      "span",
      "",
      "Only credentials that match the proxy's non-production allow-list are used. They never reach this browser.",
    ),
  )
  const endpoint = el("div", "msh-endpoint")
  const endpointCode = el("code")
  endpoint.append(el("span", "msh-endpoint-label", "Proxy"), endpointCode)

  access.append(accessHead, accessMessage, accessHint, endpoint, safety)

  // Service list.
  const refresh = button("msh-btn-ghost msh-refresh", "Refresh", "refresh")
  servicesHead.append(refresh)
  const listError = el("div", "msh-card msh-list-error")
  listError.setAttribute("role", "alert")
  listError.hidden = true
  const list = el("ul", "msh-card msh-svcs")
  list.setAttribute("role", "list")
  list.setAttribute("aria-label", "Services")
  // When the proxy itself blocks dev resources, say so once instead of under every row.
  const shared = el("p", "msh-shared")
  shared.id = id("shared")
  shared.hidden = true
  let sharedReason: string | undefined
  const same = (a: string, b: string) =>
    a.trim().replace(/\.$/, "").toLowerCase() === b.trim().replace(/\.$/, "").toLowerCase()
  servicesSection.append(listError, shared, list)
  lower.append(access, servicesSection)

  type Row = {
    li: HTMLLIElement
    service: SystemService
    pending: boolean
    error?: string | undefined
    paint(): void
  }
  const rows = new Map<string, Row>()
  let current: readonly SystemService[] = []

  const paintSummary = () => {
    summary.textContent = summarizeServices([...rows.values()].map((row) => row.service))
  }

  const createRow = (initial: SystemService): Row => {
    const li = el("li", "msh-svc")
    const main = el("div", "msh-svc-main")
    const name = el("div", "msh-svc-name")
    const label = el("span", "msh-svc-label")
    const badge = el("span", "msh-badge-live", "Dev resource")
    name.append(label, badge)
    const category = el("span", "msh-svc-cat")
    main.append(name, category)
    const group = el("div", "msh-seg")
    group.setAttribute("role", "radiogroup")
    const options = (["emulated", "dev"] as const).map((mode) => {
      const option = el("button", "msh-seg-option", mode === "emulated" ? "Emulated" : "Dev")
      option.type = "button"
      option.setAttribute("role", "radio")
      option.dataset.mode = mode
      return option
    })
    group.append(...options)
    const note = el("p", "msh-svc-note")
    note.id = id("note")
    const status = el("p", "msh-sr")
    status.setAttribute("role", "status")
    const error = el("p", "msh-error msh-svc-error")
    error.setAttribute("role", "alert")
    li.append(main, group, note, status, error)

    const row: Row = {
      li,
      service: initial,
      pending: false,
      paint() {
        const { service } = row
        li.dataset.service = service.id
        li.dataset.mode = service.mode
        li.toggleAttribute("data-pending", row.pending)
        label.textContent = service.label
        // Reserve the badge's space either way, so switching never moves the row's text.
        badge.style.visibility = service.mode === "dev" ? "visible" : "hidden"
        badge.setAttribute("aria-hidden", String(service.mode !== "dev"))
        category.textContent = service.category ?? "Service"
        group.setAttribute("aria-label", `${service.label} mode`)
        group.setAttribute("aria-busy", String(row.pending))
        for (const option of options) {
          const mode = option.dataset.mode as SystemServiceMode
          const checked = service.mode === mode
          option.setAttribute("aria-checked", String(checked))
          option.tabIndex = checked ? 0 : -1
          const blocked = mode === "dev" && service.unavailable !== undefined && !checked
          option.disabled = blocked || (row.pending && !checked)
          const sharedNote =
            sharedReason !== undefined &&
            service.unavailable !== undefined &&
            same(service.unavailable, sharedReason)
          if (blocked) option.setAttribute("aria-describedby", sharedNote ? shared.id : note.id)
          else option.removeAttribute("aria-describedby")
        }
        note.hidden =
          service.unavailable === undefined ||
          (sharedReason !== undefined && same(service.unavailable, sharedReason))
        note.innerHTML = icon("info")
        note.append(el("span", "", service.unavailable ?? ""))
        status.textContent = row.pending
          ? `Switching to ${service.mode === "dev" ? "the dev resource" : "the emulator"}…`
          : ""
        error.hidden = row.error === undefined
        error.replaceChildren()
        if (row.error !== undefined) {
          error.innerHTML = icon("alert")
          error.append(el("span", "", row.error))
        }
      },
    }
    const choose = async (mode: SystemServiceMode, focus: boolean) => {
      const option = options.find((candidate) => candidate.dataset.mode === mode)
      if (!option || option.disabled || row.pending) return
      if (focus) option.focus()
      if (row.service.mode === mode) return
      const before = row.service
      row.service = { ...before, mode }
      row.pending = true
      row.error = undefined
      row.paint()
      paintSummary()
      try {
        await services.setMode(before.id, mode)
        if (disposed) return
        current = current.map((service) => (service.id === before.id ? row.service : service))
      } catch (failure) {
        if (disposed) return
        row.service = before
        row.error = `Couldn't switch ${before.label} to ${mode}: ${message(failure)}`
      }
      row.pending = false
      row.paint()
      paintSummary()
      // Repainting disabled options can drop focus; keep it on the checked one.
      if (group.contains(doc.activeElement) || doc.activeElement === doc.body)
        options.find((candidate) => candidate.dataset.mode === row.service.mode)?.focus()
    }
    // The control is a toggle: a click on either half flips the mode.
    for (const option of options) {
      option.onclick = () => void choose(row.service.mode === "dev" ? "emulated" : "dev", false)
    }
    group.onkeydown = (event) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp"
      if (!forward && !backward) return
      event.preventDefault()
      const index = options.findIndex((option) => option.dataset.mode === row.service.mode)
      const next = options[(index + (forward ? 1 : -1) + options.length) % options.length]
      if (next) void choose(next.dataset.mode as SystemServiceMode, true)
    }
    row.paint()
    return row
  }

  const paintSkeleton = () => {
    list.replaceChildren()
    for (let index = 0; index < 4; index++) {
      const li = el("li", "msh-svc msh-skeleton")
      li.setAttribute("aria-hidden", "true")
      li.innerHTML =
        '<div class="msh-svc-main"><span class="msh-bone" style="width:38%"></span><span class="msh-bone msh-bone-sm" style="width:22%"></span></div><span class="msh-bone msh-bone-seg"></span>'
      list.append(li)
    }
    list.setAttribute("aria-busy", "true")
    summary.textContent = "Loading services…"
  }

  const paintAccess = (status: SystemDevStatus) => {
    sharedReason = status.state === "ready" ? undefined : status.message
    shared.hidden = sharedReason === undefined
    shared.innerHTML = icon("info")
    shared.append(
      el("span", "", `Dev is unavailable for every service: ${status.message.replace(/\.$/, "")}.`),
    )
    access.dataset.state = status.state
    chip.textContent = STATES[status.state].chip
    accessMessage.textContent = status.message
    accessHint.textContent = STATES[status.state].hint
    endpoint.hidden = !status.endpoint
    endpointCode.textContent = status.endpoint ?? ""
    endpointCode.title = status.endpoint ?? ""
  }

  let sequence = 0
  const load = async () => {
    const mine = ++sequence
    refresh.disabled = true
    refresh.setAttribute("aria-busy", "true")
    if (rows.size === 0) paintSkeleton()
    try {
      const result = await services.list()
      if (disposed || mine !== sequence) return
      listError.hidden = true
      paintAccess(result.dev)
      current = result.services
      const seen = new Set<string>()
      const ordered: HTMLLIElement[] = []
      for (const service of result.services) {
        seen.add(service.id)
        let row = rows.get(service.id)
        if (!row) {
          row = createRow(service)
          rows.set(service.id, row)
        } else if (!row.pending) {
          row.service = service
          row.paint()
        }
        ordered.push(row.li)
      }
      for (const [key, row] of rows)
        if (!seen.has(key)) {
          row.li.remove()
          rows.delete(key)
        }
      list.removeAttribute("aria-busy")
      if (ordered.length === 0) {
        const empty = el("li", "msh-svc msh-svc-empty", "This preview has no third-party services.")
        list.replaceChildren(empty)
      } else list.replaceChildren(...ordered)
      paintSummary()
    } catch (failure) {
      if (disposed || mine !== sequence) return
      list.removeAttribute("aria-busy")
      if (rows.size === 0) {
        list.replaceChildren()
        list.hidden = true
      }
      summary.textContent = "Services could not be listed."
      listError.hidden = false
      listError.innerHTML = icon("alert")
      listError.append(el("span", "", `Couldn't load services: ${message(failure)}`))
    } finally {
      if (!disposed && mine === sequence) {
        refresh.disabled = false
        refresh.removeAttribute("aria-busy")
        if (rows.size > 0 || listError.hidden) list.hidden = false
      }
    }
  }

  refresh.onclick = () => void load()

  access.dataset.state = "loading"
  chip.textContent = "Checking"
  accessMessage.textContent = "Checking the dev proxy…"
  accessHint.textContent = ""
  endpoint.hidden = true
  panel.append(home)
  void load()
  return () => {
    disposed = true
    home.remove()
  }
}

/** Styles for the shell, the switcher and the System screen; every rule is under `.msh`. */
export const SYSTEM_CSS = `
.msh{--msh-bg:#f4f5f7;--msh-card:#fff;--msh-text:#14181f;--msh-muted:#5b6576;--msh-faint:#8a93a3;--msh-line:#e3e6eb;--msh-line-strong:#cdd2da;--msh-hover:#f0f2f5;--msh-accent:#3451d1;--msh-accent-hover:#2a43b3;--msh-accent-text:#fff;--msh-accent-soft:#eceffd;--msh-ok:#14803c;--msh-ok-soft:#e6f5ec;--msh-warn:#a15c07;--msh-warn-soft:#fcf1dc;--msh-danger:#bf2530;--msh-danger-soft:#fdecec;--msh-off:#6b7483;--msh-off-soft:#eef0f3;--msh-live:#c2410c;--msh-live-soft:#ffefe5;--msh-shadow:0 1px 2px rgb(16 24 40/.05),0 1px 3px rgb(16 24 40/.07);--msh-ring:#3451d1;--msh-seg-bg:#eceef2;--msh-seg-on:#fff;
position:relative;height:100%;min-height:240px;isolation:isolate;color:CanvasText;background:Canvas;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){.msh{--msh-bg:#0e1116;--msh-card:#161a21;--msh-text:#e7eaf0;--msh-muted:#a0a8b6;--msh-faint:#737c8c;--msh-line:#262c36;--msh-line-strong:#353c48;--msh-hover:#1d222b;--msh-accent:#6f8cff;--msh-accent-hover:#89a0ff;--msh-accent-text:#0b1020;--msh-accent-soft:#1c2440;--msh-ok:#4ad07f;--msh-ok-soft:#12291c;--msh-warn:#f0b357;--msh-warn-soft:#2e2210;--msh-danger:#ff7b84;--msh-danger-soft:#33161a;--msh-off:#8d96a5;--msh-off-soft:#1f242c;--msh-live:#ff9a62;--msh-live-soft:#35190b;--msh-shadow:0 1px 2px rgb(0 0 0/.4);--msh-ring:#89a0ff;--msh-seg-bg:#0f1218;--msh-seg-on:#262c37}}
/* Positioned, so absolutely placed descendants (screen-reader text) scroll and clip with the
   panel instead of overflowing the shell and scrolling the page too. */
.msh-panel{position:relative;height:100%;overflow:auto}.msh [hidden]{display:none!important}
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
.msh-status{max-width:640px;padding:32px;margin:auto}
.msh-status button{display:block;margin-top:12px;padding:8px 14px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.msh :focus-visible{outline:2px solid var(--msh-ring);outline-offset:2px}

.msh-home{box-sizing:border-box;min-height:100%;background:var(--msh-bg);color:var(--msh-text);-webkit-font-smoothing:antialiased;color-scheme:light dark}
.msh-home *,.msh-home *::before,.msh-home *::after{box-sizing:border-box}
.msh-home :where(h1,h2,h3,p,ul,li){margin:0;padding:0}
.msh-home :where(ul){list-style:none}
.msh-page{max-width:1080px;margin:0 auto;padding:44px 32px 96px;display:grid;gap:40px}
.msh-icon{width:16px;height:16px;flex:none}

.msh-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 24px;padding-bottom:28px;border-bottom:1px solid var(--msh-line)}
.msh-eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--msh-accent)}
.msh-title{margin-top:6px!important;font-size:32px;line-height:1.15;font-weight:700;letter-spacing:-.02em}
.msh-subtitle{margin-top:6px!important;font-size:15px;color:var(--msh-muted)}
.msh-docs{display:inline-flex;align-items:center;gap:6px;padding:6px 2px;border-radius:6px;color:var(--msh-accent);font-weight:500;text-decoration:none}
.msh-docs:hover{text-decoration:underline;text-underline-offset:3px}
.msh-docs .msh-icon{width:14px;height:14px}

.msh-section{display:grid;gap:16px;align-content:start;min-width:0}
.msh-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.msh-h2{font-size:18px;font-weight:650;letter-spacing:-.01em}
.msh-meta{margin-top:2px!important;color:var(--msh-muted);font-size:13px}

.msh-card{background:var(--msh-card);border:1px solid var(--msh-line);border-radius:12px;box-shadow:var(--msh-shadow)}
.msh-apps{display:grid;gap:8px;position:relative;margin:0;padding:0;list-style:none}
.msh-row{display:flex;align-items:center;gap:4px;padding:6px 10px 6px 4px;position:relative;background:var(--msh-card);transition:border-color .15s,box-shadow .15s}
.msh-row:hover{border-color:var(--msh-line-strong)}
.msh-row-dragging{z-index:2;border-color:var(--msh-accent);box-shadow:0 12px 32px rgb(0 0 0/.22)}
.msh-grip{display:grid;place-items:center;flex:none;width:32px;height:44px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--msh-faint);cursor:grab;touch-action:none}
.msh-grip:hover{background:var(--msh-hover);color:var(--msh-text)}
.msh-row-dragging .msh-grip{cursor:grabbing;color:var(--msh-accent)}
.msh-grip .msh-icon{width:18px;height:18px;fill:currentColor;stroke:none}
.msh-row .msh-row-main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:8px 10px;margin:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left}
button.msh-row-main{cursor:pointer}
button.msh-row-main:hover{background:var(--msh-hover)}
.msh-row-main .msh-mark{width:32px;height:32px;font-size:14px}
.msh-row-main[aria-checked=false] .msh-mark{background:var(--msh-hover);color:var(--msh-faint)}
.msh-row-main[aria-checked=false] .msh-app-label{color:var(--msh-muted)}
/* No switch on System's row; keep its icon in line with the others'. */
.msh-row-fixed::before{content:"";flex:none;width:34px}
.msh-always{margin-left:auto;flex:none;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:var(--msh-muted);background:var(--msh-hover)}
.msh-mark{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:9px;background:var(--msh-accent-soft);color:var(--msh-accent);font-weight:700;font-size:15px;transition:background-color .15s,color .15s}
.msh-mark svg{width:19px;height:19px}
.msh-mark img{width:20px;height:20px;border-radius:4px;object-fit:contain}
.msh-row-main[aria-checked=false] .msh-mark img{filter:grayscale(1);opacity:.6}
.msh-tip-icon{display:inline-grid;place-items:center;width:14px;height:14px;margin-right:6px;vertical-align:-2px;font-size:10px;font-weight:700}
.msh-tip-icon svg,.msh-tip-icon img{width:14px;height:14px}
.msh-app-text{display:grid;min-width:0}
.msh-app-label{font-size:15px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}
.msh-app-desc{color:var(--msh-muted);font-size:13px;font-weight:400}
.msh-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

.msh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:6px 12px;border-radius:8px;border:1px solid transparent;font:inherit;font-weight:550;font-size:13px;line-height:1.2;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s,color .15s}
.msh-btn:disabled{cursor:default;opacity:.55}
.msh-btn-secondary{background:var(--msh-card);border-color:var(--msh-line-strong);color:var(--msh-text)}
.msh-btn-secondary:hover:not(:disabled){background:var(--msh-hover)}
.msh-btn-ghost{background:transparent;color:var(--msh-muted)}
.msh-btn-ghost:hover:not(:disabled){background:var(--msh-hover);color:var(--msh-text)}
.msh-open .msh-icon{width:14px;height:14px}
.msh-refresh[aria-busy=true] .msh-icon{animation:msh-spin .8s linear infinite}

.msh-switch{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:4px 6px 4px 2px;margin-left:-2px;border:0;border-radius:8px;background:transparent;color:var(--msh-muted);font:inherit;font-size:13px;cursor:pointer}
.msh-switch:hover{color:var(--msh-text)}
.msh-track{position:relative;flex:none;width:34px;height:20px;border-radius:999px;background:var(--msh-line-strong);transition:background-color .15s}
.msh-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.25);transition:transform .15s}
.msh-switch[aria-checked=true] .msh-track{background:var(--msh-accent)}
.msh-switch[aria-checked=true] .msh-thumb{transform:translateX(14px)}
.msh-switch[aria-checked=true]{color:var(--msh-text)}

.msh-lower{display:grid;grid-template-columns:minmax(0,1fr) 330px;grid-template-areas:"services access";gap:24px;align-items:start}
.msh-lower-single{grid-template-columns:minmax(0,1fr);grid-template-areas:"services"}
.msh-services{grid-area:services}
.msh-access{grid-area:access;position:sticky;top:20px;display:grid;gap:12px;padding:18px;border-top:3px solid var(--msh-state,var(--msh-off))}

.msh-access-head{display:flex;align-items:center;gap:10px}
.msh-access-title{font-size:15px;font-weight:650;flex:1}
.msh-dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--msh-state,var(--msh-off));box-shadow:0 0 0 4px var(--msh-state-soft,var(--msh-off-soft))}
.msh-chip{padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;background:var(--msh-state-soft,var(--msh-off-soft));color:var(--msh-state,var(--msh-off))}
.msh-access[data-state=ready]{--msh-state:var(--msh-ok);--msh-state-soft:var(--msh-ok-soft)}
.msh-access[data-state=unreachable]{--msh-state:var(--msh-danger);--msh-state-soft:var(--msh-danger-soft)}
.msh-access[data-state=none]{--msh-state:var(--msh-faint);--msh-state-soft:var(--msh-off-soft)}
.msh-access[data-state=none] .msh-dot{background:transparent;box-shadow:inset 0 0 0 2px var(--msh-faint)}
.msh-access[data-state=loading] .msh-dot{animation:msh-pulse 1.2s ease-in-out infinite}
.msh-access-msg{font-weight:550}
.msh-access-hint{color:var(--msh-muted);font-size:13px}
.msh-endpoint{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:8px;background:var(--msh-bg);border:1px solid var(--msh-line);min-width:0}
.msh-endpoint-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--msh-faint)}
.msh-endpoint code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--msh-text)}
.msh-shared{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-radius:10px;font-size:13px;color:var(--msh-muted);background:var(--msh-off-soft);border:1px solid var(--msh-line)}
.msh-shared .msh-icon{margin-top:2px}
.msh-safety{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--msh-muted)}.msh-safety .msh-icon{flex:none;width:14px;height:14px;margin-top:1px;color:var(--msh-ok)}

.msh-svcs{overflow:hidden}
.msh-svc{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:14px 16px;border-top:1px solid var(--msh-line);transition:background-color .15s}
.msh-svc:first-child{border-top:0}
.msh-svc[data-mode=dev]{background:linear-gradient(90deg,var(--msh-live-soft),transparent 55%);box-shadow:inset 3px 0 0 var(--msh-live)}
.msh-svc-main{flex:1 1 200px;min-width:0;display:grid;gap:2px}
.msh-svc-name{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.msh-svc-label{font-weight:600;font-size:14.5px}
.msh-svc-cat{font-size:12.5px;color:var(--msh-muted)}
.msh-badge-live{display:inline-flex;align-items:center;gap:6px;padding:1px 8px 1px 7px;border-radius:999px;background:var(--msh-live-soft);color:var(--msh-live);border:1px solid color-mix(in srgb,var(--msh-live) 30%,transparent);font-size:11.5px;font-weight:650;letter-spacing:.01em}
.msh-badge-live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:msh-pulse 1.6s ease-in-out infinite}
.msh-seg{display:inline-flex;flex:none;padding:3px;gap:2px;border-radius:9px;background:var(--msh-seg-bg);border:1px solid var(--msh-line)}
.msh-seg-option{min-width:86px;min-height:30px;padding:4px 12px;border:0;border-radius:6px;background:transparent;color:var(--msh-muted);font:inherit;font-size:13px;font-weight:550;cursor:pointer;transition:background-color .15s,color .15s}
.msh-seg-option:hover:not(:disabled){color:var(--msh-text)}
.msh-seg-option[aria-checked=true]{background:var(--msh-seg-on);color:var(--msh-text);box-shadow:0 1px 2px rgb(16 24 40/.12),0 0 0 1px var(--msh-line)}
.msh-seg-option[data-mode=dev][aria-checked=true]{color:var(--msh-live)}
.msh-seg-option:disabled{cursor:not-allowed;color:var(--msh-faint);opacity:.7}
.msh-seg{position:relative}
.msh-seg[aria-busy=true] .msh-seg-option[aria-checked=true]{opacity:.7}
/* Switching: a spinner over the control instead of a status line, so nothing moves. */
.msh-seg[aria-busy=true]::after{content:"";position:absolute;top:50%;right:9px;width:12px;height:12px;margin-top:-6px;border-radius:50%;border:2px solid var(--msh-line-strong);border-top-color:var(--msh-accent);animation:msh-spin .7s linear infinite}
.msh-svc-note,.msh-svc-error{flex-basis:100%;display:flex;align-items:flex-start;gap:6px;font-size:12.5px}
.msh-svc-note{color:var(--msh-muted)}
.msh-svc-note .msh-icon,.msh-error .msh-icon{width:14px;height:14px;margin-top:2px}
.msh-error{display:flex;align-items:flex-start;gap:6px;color:var(--msh-danger);font-size:12.5px;font-weight:500}
.msh-svc-error{padding:8px 10px;border-radius:8px;background:var(--msh-danger-soft)}
.msh-svc-empty{color:var(--msh-muted)}
.msh-list-error{display:flex;align-items:flex-start;gap:8px;padding:14px 16px;color:var(--msh-danger);background:var(--msh-danger-soft);border-color:transparent}
.msh-bone{display:block;height:12px;border-radius:6px;background:var(--msh-seg-bg);animation:msh-pulse 1.2s ease-in-out infinite}
.msh-bone-sm{height:10px;margin-top:6px}
.msh-bone-seg{width:176px;height:36px;border-radius:9px}

.msh-empty{display:flex;gap:14px;align-items:flex-start;padding:20px;border-style:dashed;box-shadow:none;background:transparent}
.msh-empty>.msh-icon{width:22px;height:22px;color:var(--msh-faint);margin-top:2px}
.msh-empty-title{font-weight:600}
.msh-empty-body{margin-top:4px!important;color:var(--msh-muted);font-size:13px;max-width:60ch}

@keyframes msh-spin{to{transform:rotate(360deg)}}
@keyframes msh-pulse{50%{opacity:.45}}
@media (max-width:860px){
.msh-lower{grid-template-columns:minmax(0,1fr);grid-template-areas:"access" "services"}
.msh-access{position:static}
}
@media (max-width:560px){
.msh-page{padding:28px 16px 88px;gap:32px}
.msh-header{padding-bottom:20px}
.msh-title{font-size:26px}
.msh-seg{width:100%}
.msh-seg-option{flex:1}
.msh-bone-seg{width:100%}
}
@media (prefers-reduced-motion:reduce){
.msh *,.msh *::before,.msh *::after{animation:none!important;transition:none!important}
}
`
