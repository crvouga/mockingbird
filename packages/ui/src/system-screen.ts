/// <reference lib="dom" />
import { summarizeServices } from "./system-rotation.js"

export type SystemServiceMode = "emulated" | "sandbox"

/** One third-party service behind the preview, and where its requests go. */
export type SystemService = {
  id: string
  label: string
  category?: string
  mode: SystemServiceMode
  /** Why sandbox cannot be chosen; undefined when it can. */
  unavailable?: string
}

/** Whether this browser can reach the sandbox proxy, in one sentence. */
export type SystemSandboxStatus = {
  state: "ready" | "locked" | "off" | "unreachable" | "none"
  /** One sentence shown in the access panel. */
  message: string
  /** The proxy URL, displayed. */
  endpoint?: string
}

/** What the System screen lists and switches. `@crvouga/mockingbird-preview`'s `controls()` is one. */
export type SystemServices = {
  list(): Promise<{ sandbox: SystemSandboxStatus; services: readonly SystemService[] }>
  setMode(id: string, mode: SystemServiceMode): Promise<void>
  setAccessKey(key: string | null): Promise<void>
  hasAccessKey(): boolean
}

/** What the harness hands the System screen. */
export type SystemScreenContext = {
  apps: readonly { id: string; label: string; description?: string | undefined }[]
  open(id: string): void
  inRotation(id: string): boolean
  setInRotation(id: string, included: boolean): void
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
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M15 8l2 2"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4"/>',
} as const
const icon = (name: keyof typeof ICONS) =>
  `<svg class="msh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`

const STATES: Record<SystemSandboxStatus["state"], { chip: string; hint: string }> = {
  ready: {
    chip: "Ready",
    hint: "Services that support it can send their requests to the vendor's sandbox.",
  },
  locked: {
    chip: "Locked",
    hint: "Ask whoever runs this preview for the access key. It is kept only in this browser.",
  },
  off: {
    chip: "Off",
    hint: "Whoever runs the proxy turns sandbox mode on by giving it an access key.",
  },
  unreachable: {
    chip: "Unreachable",
    hint: "Check that the proxy is running and allows this origin, then refresh.",
  },
  none: {
    chip: "Not set up",
    hint: "Every service is emulated in this tab. Deploy the sandbox proxy and give its URL to this preview to offer sandbox mode.",
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
    docs.append(el("span", "", "How sandbox mode works"))
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
  const paintAppsMeta = () => {
    const included = context.apps.filter((app) => context.inRotation(app.id)).length
    appsMeta.textContent =
      context.apps.length === 0
        ? "This preview has no apps yet."
        : `${context.apps.length} ${context.apps.length === 1 ? "app" : "apps"} · ${included} in the switcher. The arrows skip the ones you switch off.`
  }
  paintAppsMeta()
  if (context.apps.length > 0) {
    const grid = el("ul", "msh-apps")
    grid.setAttribute("role", "list")
    for (const app of context.apps) {
      const card = el("li", "msh-card msh-app")
      card.dataset.app = app.id
      const top = el("div", "msh-app-top")
      const mark = el("span", "msh-mark", (app.label.trim()[0] ?? "?").toUpperCase())
      mark.setAttribute("aria-hidden", "true")
      const text = el("div", "msh-app-text")
      text.append(el("h3", "msh-app-label", app.label))
      if (app.description) text.append(el("p", "msh-app-desc", app.description))
      top.append(mark, text)

      const foot = el("div", "msh-app-foot")
      const toggle = el("button", "msh-switch")
      toggle.type = "button"
      toggle.setAttribute("role", "switch")
      toggle.setAttribute("aria-label", `${app.label} in switcher`)
      toggle.innerHTML =
        '<span class="msh-track" aria-hidden="true"><span class="msh-thumb"></span></span>'
      toggle.append(el("span", "msh-switch-label", "In switcher"))
      const paintToggle = () =>
        toggle.setAttribute("aria-checked", String(context.inRotation(app.id)))
      paintToggle()
      toggle.onclick = () => {
        context.setInRotation(app.id, !context.inRotation(app.id))
        paintToggle()
        paintAppsMeta()
      }
      const open = button("msh-btn-secondary msh-open", "Open", "open")
      open.setAttribute("aria-label", `Open ${app.label}`)
      // Icon after the text reads better for "Open ↗".
      open.append(open.querySelector("svg") as SVGElement)
      open.onclick = () => context.open(app.id)
      foot.append(toggle, open)
      card.append(top, foot)
      grid.append(card)
    }
    apps.append(grid)
  }
  page.append(apps)

  // ---- services + sandbox access
  const services = context.services
  const lower = el("div", services ? "msh-lower" : "msh-lower msh-lower-single")
  page.append(lower)

  const servicesSection = el("section", "msh-section msh-services")
  const servicesHeading = el("h2", "msh-h2", "Services")
  servicesHeading.id = id("services")
  servicesSection.setAttribute("aria-labelledby", servicesHeading.id)
  const servicesHead = el("div", "msh-section-head")
  const servicesTitles = el("div")
  const summary = el("p", "msh-meta")
  summary.dataset.testid = "system-services-summary"
  servicesTitles.append(servicesHeading, summary)
  servicesHead.append(servicesTitles)
  servicesSection.append(servicesHead)

  if (!services) {
    summary.textContent = "Third-party APIs the apps call."
    const empty = el("div", "msh-card msh-empty")
    empty.innerHTML = icon("plug")
    const emptyText = el("div")
    emptyText.append(
      el("p", "msh-empty-title", "No services listed"),
      el(
        "p",
        "msh-empty-body",
        "The host app supplies them. When it passes its services to the harness, each emulator appears here and can switch between running in this tab and the vendor's sandbox.",
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

  // Sandbox access panel.
  const access = el("section", "msh-card msh-access")
  const accessHeading = el("h2", "msh-access-title", "Sandbox access")
  accessHeading.id = id("access")
  access.setAttribute("aria-labelledby", accessHeading.id)
  access.dataset.testid = "system-sandbox-access"
  const accessHead = el("div", "msh-access-head")
  const dot = el("span", "msh-dot")
  dot.setAttribute("aria-hidden", "true")
  const chip = el("span", "msh-chip")
  accessHead.append(dot, accessHeading, chip)
  const accessMessage = el("p", "msh-access-msg")
  const accessHint = el("p", "msh-access-hint")
  const endpoint = el("div", "msh-endpoint")
  const endpointCode = el("code")
  endpoint.append(el("span", "msh-endpoint-label", "Proxy"), endpointCode)

  const form = el("form", "msh-key")
  const inputId = id("key")
  const keyLabel = el("label", "msh-key-label", "Access key")
  keyLabel.htmlFor = inputId
  const keyRow = el("div", "msh-key-row")
  const keyInput = el("input", "msh-input")
  keyInput.id = inputId
  keyInput.type = "password"
  keyInput.autocomplete = "off"
  keyInput.spellcheck = false
  keyInput.placeholder = "Paste the sandbox access key"
  const save = el("button", "msh-btn msh-btn-primary", "Save key")
  save.type = "submit"
  const forget = button("msh-btn-ghost", "Forget key")
  keyRow.append(keyInput, save, forget)
  const keyNote = el("p", "msh-key-note")
  const keyError = el("p", "msh-error")
  keyError.setAttribute("role", "alert")
  keyError.hidden = true
  form.append(keyLabel, keyRow, keyNote, keyError)
  access.append(accessHead, accessMessage, accessHint, endpoint, form)

  // Service list.
  const refresh = button("msh-btn-ghost msh-refresh", "Refresh", "refresh")
  servicesHead.append(refresh)
  const listError = el("div", "msh-card msh-list-error")
  listError.setAttribute("role", "alert")
  listError.hidden = true
  const list = el("ul", "msh-card msh-svcs")
  list.setAttribute("role", "list")
  list.setAttribute("aria-label", "Services")
  // When the proxy itself blocks sandbox, say so once instead of under every row.
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
    const badge = el("span", "msh-badge-live", "Live sandbox")
    name.append(label, badge)
    const category = el("span", "msh-svc-cat")
    main.append(name, category)
    const group = el("div", "msh-seg")
    group.setAttribute("role", "radiogroup")
    const options = (["emulated", "sandbox"] as const).map((mode) => {
      const option = el("button", "msh-seg-option", mode === "emulated" ? "Emulated" : "Sandbox")
      option.type = "button"
      option.setAttribute("role", "radio")
      option.dataset.mode = mode
      return option
    })
    group.append(...options)
    const note = el("p", "msh-svc-note")
    note.id = id("note")
    const status = el("p", "msh-svc-status")
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
        badge.hidden = service.mode !== "sandbox"
        category.textContent = service.category ?? "Service"
        group.setAttribute("aria-label", `${service.label} mode`)
        group.setAttribute("aria-busy", String(row.pending))
        for (const option of options) {
          const mode = option.dataset.mode as SystemServiceMode
          const checked = service.mode === mode
          option.setAttribute("aria-checked", String(checked))
          option.tabIndex = checked ? 0 : -1
          const blocked = mode === "sandbox" && service.unavailable !== undefined && !checked
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
          ? `Switching to ${service.mode === "sandbox" ? "the vendor sandbox" : "the emulator"}…`
          : ""
        status.hidden = !row.pending
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
    for (const option of options) {
      option.onclick = () => void choose(option.dataset.mode as SystemServiceMode, false)
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

  const paintAccess = (status: SystemSandboxStatus) => {
    sharedReason = status.state === "ready" ? undefined : status.message
    shared.hidden = sharedReason === undefined
    shared.innerHTML = icon(status.state === "locked" ? "key" : "info")
    shared.append(
      el(
        "span",
        "",
        `Sandbox is unavailable for every service: ${status.message.replace(/\.$/, "")}.`,
      ),
    )
    access.dataset.state = status.state
    chip.textContent = STATES[status.state].chip
    accessMessage.textContent = status.message
    accessHint.textContent = STATES[status.state].hint
    endpoint.hidden = !status.endpoint
    endpointCode.textContent = status.endpoint ?? ""
    endpointCode.title = status.endpoint ?? ""
    const hasKey = services.hasAccessKey()
    form.hidden = status.state !== "ready" && status.state !== "locked"
    forget.hidden = !hasKey
    keyNote.textContent = hasKey
      ? "A key is saved in this browser. Saving a new one replaces it."
      : "Only sent to the proxy, never to a vendor."
    keyInput.placeholder = hasKey ? "Paste a new key to replace it" : "Paste the sandbox access key"
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
      paintAccess(result.sandbox)
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
  const saveKey = async (key: string | null) => {
    keyError.hidden = true
    save.disabled = true
    forget.disabled = true
    try {
      await services.setAccessKey(key)
      if (disposed) return
      keyInput.value = ""
      await load()
    } catch (failure) {
      if (disposed) return
      keyError.hidden = false
      keyError.textContent = message(failure)
    } finally {
      save.disabled = false
      forget.disabled = false
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault()
    const key = keyInput.value.trim()
    if (!key) {
      keyError.hidden = false
      keyError.textContent = "Enter the access key first."
      keyInput.focus()
      return
    }
    void saveKey(key)
  }
  forget.onclick = () => void saveKey(null)

  access.dataset.state = "loading"
  chip.textContent = "Checking"
  accessMessage.textContent = "Checking the sandbox proxy…"
  accessHint.textContent = ""
  endpoint.hidden = true
  form.hidden = true
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
.msh-apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr));gap:14px}
.msh-app{display:flex;flex-direction:column;gap:16px;padding:16px;transition:border-color .15s}
.msh-app:hover{border-color:var(--msh-line-strong)}
.msh-app-top{display:flex;gap:12px;align-items:flex-start;flex:1}
.msh-mark{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:9px;background:var(--msh-accent-soft);color:var(--msh-accent);font-weight:700;font-size:15px}
.msh-app-text{min-width:0}
.msh-app-label{font-size:15px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}
.msh-app-desc{margin-top:2px!important;color:var(--msh-muted);font-size:13px}
.msh-app-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:12px;border-top:1px solid var(--msh-line)}

.msh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:6px 12px;border-radius:8px;border:1px solid transparent;font:inherit;font-weight:550;font-size:13px;line-height:1.2;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s,color .15s}
.msh-btn:disabled{cursor:default;opacity:.55}
.msh-btn-primary{background:var(--msh-accent);color:var(--msh-accent-text)}
.msh-btn-primary:hover:not(:disabled){background:var(--msh-accent-hover)}
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
.msh-access[data-state=locked]{--msh-state:var(--msh-warn);--msh-state-soft:var(--msh-warn-soft)}
.msh-access[data-state=unreachable]{--msh-state:var(--msh-danger);--msh-state-soft:var(--msh-danger-soft)}
.msh-access[data-state=off]{--msh-state:var(--msh-off);--msh-state-soft:var(--msh-off-soft)}
.msh-access[data-state=none]{--msh-state:var(--msh-faint);--msh-state-soft:var(--msh-off-soft)}
.msh-access[data-state=none] .msh-dot{background:transparent;box-shadow:inset 0 0 0 2px var(--msh-faint)}
.msh-access[data-state=loading] .msh-dot{animation:msh-pulse 1.2s ease-in-out infinite}
.msh-access-msg{font-weight:550}
.msh-access-hint{color:var(--msh-muted);font-size:13px}
.msh-endpoint{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:8px;background:var(--msh-bg);border:1px solid var(--msh-line);min-width:0}
.msh-endpoint-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--msh-faint)}
.msh-endpoint code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--msh-text)}
.msh-key{display:grid;gap:6px;padding-top:12px;border-top:1px solid var(--msh-line)}
.msh-key-label{font-size:13px;font-weight:600}
.msh-key-row{display:flex;flex-wrap:wrap;gap:8px}
.msh-input{flex:1 1 160px;min-width:0;min-height:34px;padding:6px 10px;border:1px solid var(--msh-line-strong);border-radius:8px;background:var(--msh-card);color:var(--msh-text);font:inherit;font-size:13px}
.msh-input::placeholder{color:var(--msh-faint)}
.msh-input:focus-visible{outline:2px solid var(--msh-ring);outline-offset:0;border-color:transparent}
.msh-key-row .msh-input{flex-basis:100%}
.msh-shared{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-radius:10px;font-size:13px;color:var(--msh-muted);background:var(--msh-off-soft);border:1px solid var(--msh-line)}
.msh-shared .msh-icon{margin-top:2px}
.msh-key-note{font-size:12px;color:var(--msh-faint)}

.msh-svcs{overflow:hidden}
.msh-svc{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:14px 16px;border-top:1px solid var(--msh-line);transition:background-color .15s}
.msh-svc:first-child{border-top:0}
.msh-svc[data-mode=sandbox]{background:linear-gradient(90deg,var(--msh-live-soft),transparent 55%);box-shadow:inset 3px 0 0 var(--msh-live)}
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
.msh-seg-option[data-mode=sandbox][aria-checked=true]{color:var(--msh-live)}
.msh-seg-option:disabled{cursor:not-allowed;color:var(--msh-faint);opacity:.7}
.msh-seg[aria-busy=true] .msh-seg-option[aria-checked=true]{opacity:.7}
.msh-svc-note,.msh-svc-status,.msh-svc-error{flex-basis:100%;display:flex;align-items:flex-start;gap:6px;font-size:12.5px}
.msh-svc-note{color:var(--msh-muted)}
.msh-svc-note .msh-icon,.msh-error .msh-icon{width:14px;height:14px;margin-top:2px}
.msh-svc-status{color:var(--msh-muted)}
.msh-svc-status::before{content:"";flex:none;width:12px;height:12px;margin-top:3px;border-radius:50%;border:2px solid var(--msh-line-strong);border-top-color:var(--msh-accent);animation:msh-spin .7s linear infinite}
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
