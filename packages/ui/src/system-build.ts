/// <reference lib="dom" />

import {
  ago,
  type BuildTone,
  buildStatus,
  nextVersion,
  type SystemBuild,
  secondsUntil,
  shortSha,
  tickAfter,
} from "./system-build-status.js"

export type { SystemBuild, SystemBuildState } from "./system-build-status.js"

const svg = (paths: string, className = "msh-icon") =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const EXTERNAL = svg(
  '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
)
const CHECK = svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>')
const ALERT = svg(
  '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
)
const UPDATE = svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>')

const absolute = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/**
 * Relative times that repaint on their own: every second while one is under a minute old, then
 * every 15 s. Only the `<time>` elements' text changes, never the screen around them.
 */
export function createClock(win: Window, now: () => number = Date.now) {
  type Entry = { node: HTMLTimeElement; iso: string; format: (relative: string) => string }
  const entries = new Set<Entry>()
  let timer: number | undefined
  let due = Number.POSITIVE_INFINITY
  const schedule = () => {
    const at = now()
    let delay = Number.POSITIVE_INFINITY
    for (const entry of entries) delay = Math.min(delay, tickAfter(entry.iso, at))
    if (delay === Number.POSITIVE_INFINITY) return
    if (timer !== undefined && due <= at + delay) return
    if (timer !== undefined) win.clearTimeout(timer)
    due = at + delay
    timer = win.setTimeout(tick, delay)
  }
  const tick = () => {
    timer = undefined
    due = Number.POSITIVE_INFINITY
    const at = now()
    for (const entry of entries) {
      if (!entry.node.isConnected) entries.delete(entry)
      else entry.node.textContent = entry.format(ago(entry.iso, at))
    }
    schedule()
  }
  return {
    /** A `<time>` with the absolute time as its title, reading `format("3 min ago")`. */
    time(iso: string, format: (relative: string) => string = (relative) => relative) {
      const node = win.document.createElement("time")
      node.dateTime = iso
      node.title = absolute(iso)
      node.textContent = format(ago(iso, now()))
      entries.add({ node, iso, format })
      schedule()
      return node
    },
    dispose() {
      if (timer !== undefined) win.clearTimeout(timer)
      timer = undefined
      entries.clear()
    },
  }
}
export type Clock = ReturnType<typeof createClock>

/**
 * The switcher's status dot and the update toast beside it. The dot sits on the pill's corner
 * without changing its size; the toast is placed beside the pill, never over it.
 */
export function mountBuildChrome(options: {
  build: SystemBuild
  shell: HTMLElement
  chrome: HTMLElement
  switcher: HTMLElement
  /** Opens the System screen. */
  open(): void
  /** True while a drag is ending, so its click must not act. */
  dragging(): boolean
  /** The dot's status changed: repaint its tooltip if it is showing. */
  changed(): void
}) {
  const { build, shell, chrome, switcher } = options
  const doc = shell.ownerDocument
  const win = doc.defaultView ?? window
  const dot = doc.createElement("button")
  dot.type = "button"
  dot.className = "msh-build-dot"
  dot.dataset.testid = "system-build-dot"
  switcher.append(dot)

  const toast = doc.createElement("div")
  toast.className = "msh-toast"
  toast.setAttribute("role", "status")
  toast.dataset.testid = "system-update-toast"
  toast.hidden = true
  const mark = doc.createElement("span")
  mark.className = "msh-toast-mark"
  mark.setAttribute("aria-hidden", "true")
  const text = doc.createElement("p")
  text.className = "msh-toast-text"
  const actions = doc.createElement("div")
  actions.className = "msh-toast-actions"
  const action = (label: string, className: string) => {
    const node = doc.createElement("button")
    node.type = "button"
    node.className = `msh-toast-btn ${className}`
    node.textContent = label
    return node
  }
  const later = action("Not now", "msh-toast-later")
  const now = action("Update now", "msh-toast-now")
  actions.append(later, now)
  toast.append(mark, text, actions)
  // Before the tooltip, so a tooltip shown over it stays on top.
  chrome.insertBefore(toast, chrome.querySelector(".msh-tip"))

  let state = build.get()
  let dismissed: string | undefined
  let status = buildStatus(state, Date.now())
  let countdown: number | undefined

  const paint = () => {
    const at = Date.now()
    status = buildStatus(state, at)
    dot.dataset.tone = status.tone
    dot.dataset.live = String(state.connection === "live")
    dot.setAttribute("aria-label", `Preview status: ${status.text}`)

    const next = nextVersion(state)
    const { update } = state
    const showing =
      update.available && (update.applying || update.error !== undefined || next !== dismissed)
    const wasHidden = toast.hidden
    toast.hidden = !showing
    if (showing) {
      const target = shortSha(next ?? "")
      toast.dataset.mode = update.applying ? "applying" : update.error ? "error" : "ready"
      if (update.applying) {
        text.replaceChildren("Updating…")
        actions.hidden = true
      } else if (update.error) {
        const title = doc.createElement("strong")
        title.textContent = `Couldn't update to ${target}.`
        text.replaceChildren(title, ` ${update.error}`)
        now.textContent = "Retry"
        actions.hidden = false
      } else {
        const title = doc.createElement("strong")
        title.textContent = `New version ${target} ready`
        text.replaceChildren(title)
        if (update.auto && update.autoApplyAt) {
          const left = doc.createElement("span")
          left.className = "msh-toast-countdown"
          left.textContent = ` · updating in ${secondsUntil(update.autoApplyAt, at)}s`
          text.append(left)
        }
        now.textContent = "Update now"
        actions.hidden = false
      }
      place()
    } else if (!wasHidden && toast.contains(doc.activeElement)) {
      // Leave focus somewhere sensible rather than on a hidden button.
      dot.focus()
    }
    const ticking = update.available && !update.applying && update.auto && !!update.autoApplyAt
    if (ticking && countdown === undefined) countdown = win.setInterval(paint, 1000)
    if (!ticking && countdown !== undefined) {
      win.clearInterval(countdown)
      countdown = undefined
    }
    options.changed()
  }

  /** Beside the pill on the side with room, else below or above it; never over it. */
  function place() {
    if (toast.hidden) return
    const GAP = 10
    const EDGE = 8
    const width = shell.clientWidth
    const height = shell.clientHeight
    toast.style.maxWidth = `${Math.max(160, Math.min(380, width - EDGE * 2))}px`
    const box = shell.getBoundingClientRect()
    const rect = switcher.getBoundingClientRect()
    const pill = switcher.hidden
      ? { left: EDGE, right: EDGE, top: height - EDGE, bottom: height - EDGE }
      : {
          left: rect.left - box.left,
          right: rect.right - box.left,
          top: rect.top - box.top,
          bottom: rect.bottom - box.top,
        }
    const w = toast.offsetWidth
    const h = toast.offsetHeight
    const middleY = (pill.top + pill.bottom) / 2 - h / 2
    const middleX = (pill.left + pill.right) / 2 - w / 2
    const clampX = (x: number) => Math.max(EDGE, Math.min(x, width - w - EDGE))
    const clampY = (y: number) => Math.max(EDGE, Math.min(y, height - h - EDGE))
    const candidates = {
      right: {
        x: pill.right + GAP,
        y: clampY(middleY),
        fits: pill.right + GAP + w <= width - EDGE,
      },
      left: { x: pill.left - GAP - w, y: clampY(middleY), fits: pill.left - GAP - w >= EDGE },
      below: {
        x: clampX(middleX),
        y: pill.bottom + GAP,
        fits: pill.bottom + GAP + h <= height - EDGE,
      },
      above: { x: clampX(middleX), y: pill.top - GAP - h, fits: pill.top - GAP - h >= EDGE },
    }
    // Facing into the page first: right of a pill on the left edge, above one at the bottom.
    const roomRight = width - pill.right
    const roomBelow = height - pill.bottom
    const horizontal =
      roomRight >= pill.left ? (["right", "left"] as const) : (["left", "right"] as const)
    const vertical =
      roomBelow >= pill.top ? (["below", "above"] as const) : (["above", "below"] as const)
    const sideways = Math.min(pill.left, roomRight) <= Math.min(pill.top, roomBelow)
    const order = sideways ? [...horizontal, ...vertical] : [...vertical, ...horizontal]
    const chosen = candidates[order.find((name) => candidates[name].fits) ?? vertical[0]]
    toast.dataset.side = order.find((name) => candidates[name] === chosen) ?? vertical[0]
    toast.style.left = `${chosen.x}px`
    toast.style.top = `${chosen.y}px`
  }

  dot.onclick = () => {
    if (options.dragging()) return
    options.open()
  }
  later.onclick = () => {
    dismissed = nextVersion(state)
    build.postpone()
    paint()
  }
  now.onclick = () => {
    void build.applyUpdate().catch(() => {
      /* The source reports a failure through `update.error`. */
    })
  }
  toast.onkeydown = (event) => {
    if (event.key === "Escape" && !state.update.applying) later.click()
  }

  const unsubscribe = build.subscribe((next) => {
    state = next
    paint()
  })
  paint()
  return {
    dot,
    /** The dot's tooltip: its tone and status line. */
    tip(): { tone: BuildTone; text: string } {
      return status
    },
    place,
    dispose() {
      unsubscribe()
      if (countdown !== undefined) win.clearInterval(countdown)
      dot.remove()
      toast.remove()
    },
  }
}

const CHIPS: Record<BuildTone, string> = {
  ok: "Up to date",
  building: "Building",
  ready: "Update ready",
  failed: "Needs attention",
  offline: "Offline",
}

/** The System screen's Preview card: this tab's version, the latest deploy, build, checks and connection. */
export function mountPreviewCard(doc: Document, build: SystemBuild, uid: (name: string) => string) {
  const win = doc.defaultView ?? window
  const clock = createClock(win)
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const link = (href: string, label: string, name?: string) => {
    const node = el("a", "msh-preview-link")
    node.href = href
    node.target = "_blank"
    node.rel = "noreferrer"
    node.append(el("span", "", label))
    node.insertAdjacentHTML("beforeend", EXTERNAL)
    if (name) node.setAttribute("aria-label", name)
    return node
  }
  const sha = (version: string) => {
    const code = el("code", "msh-sha", shortSha(version))
    code.title = version
    return code
  }
  const chip = (tone: "ok" | "busy" | "failed", label: string) => {
    const node = el("span", `msh-state-chip msh-state-${tone}`)
    if (tone === "busy") node.append(el("span", "msh-spinner"))
    node.append(label)
    return node
  }
  const line = (className = "msh-preview-sub") => el("span", className)
  /** Parts separated by "·"; on the main line by space alone. A separator wraps with the part after it. */
  const joined = (parent: HTMLElement, ...parts: (Node | string | undefined)[]) => {
    const dotted = !parent.classList.contains("msh-preview-main")
    let first = true
    for (const part of parts) {
      if (part === undefined) continue
      // A link reads apart on its own; dots go between plain facts.
      if (first || !dotted || (part instanceof HTMLElement && part.tagName === "A"))
        parent.append(part)
      else {
        const group = el("span", "msh-sep-group")
        group.append(el("span", "msh-sep", "·"), part)
        parent.append(group)
      }
      first = false
    }
    return parent
  }

  const card = el("section", "msh-card msh-preview")
  card.dataset.testid = "system-preview"
  const heading = el("h2", "msh-access-title", "Preview")
  heading.id = uid("preview")
  card.setAttribute("aria-labelledby", heading.id)
  const head = el("div", "msh-preview-head")
  const dot = el("span", "msh-dot")
  dot.setAttribute("aria-hidden", "true")
  const stateChip = el("span", "msh-chip")
  const pr = el("a", "msh-preview-pr")
  pr.target = "_blank"
  pr.rel = "noreferrer"
  head.append(dot, heading, stateChip, pr)

  const grid = el("dl", "msh-preview-grid")
  type Item = { dd: HTMLElement; key: string }
  const items = new Map<string, Item>()
  for (const [id, label] of [
    ["tab", "This tab"],
    ["latest", "Latest deployed"],
    ["build", "Build"],
    ["checks", "Checks"],
    ["connection", "Connection"],
  ] as const) {
    const item = el("div", "msh-preview-item")
    item.dataset.row = id
    const dd = el("dd", "msh-preview-value")
    item.append(el("dt", "msh-preview-label", label), dd)
    grid.append(item)
    items.set(id, { dd, key: "" })
  }
  /** Redraws one row only when what it shows changed, so its links keep focus and times keep ticking. */
  const row = (id: string, key: unknown, draw: (dd: HTMLElement) => void) => {
    const item = items.get(id) as Item
    const next = JSON.stringify(key)
    if (item.key === next) return
    item.key = next
    item.dd.replaceChildren()
    draw(item.dd)
  }

  const error = el("p", "msh-error msh-preview-error")
  error.setAttribute("role", "alert")
  const foot = el("div", "msh-preview-foot")
  const auto = el("button", "msh-switch msh-preview-auto")
  auto.type = "button"
  auto.setAttribute("role", "switch")
  auto.innerHTML =
    '<span class="msh-track" aria-hidden="true"><span class="msh-thumb"></span></span>'
  const autoText = el("span", "msh-preview-auto-text")
  const autoHint = el(
    "span",
    "msh-preview-auto-hint",
    "New versions apply themselves after a short countdown",
  )
  autoHint.id = uid("auto-hint")
  autoText.append(el("span", "msh-preview-auto-label", "Auto-update"), autoHint)
  auto.append(autoText)
  auto.setAttribute("aria-label", "Auto-update")
  auto.setAttribute("aria-describedby", autoHint.id)
  const updateNow = el("button", "msh-btn msh-btn-primary msh-preview-update")
  updateNow.type = "button"
  updateNow.innerHTML = UPDATE
  const updateLabel = el("span", "", "Update now")
  updateNow.append(updateLabel)
  foot.append(auto, updateNow)
  card.append(head, grid, error, foot)

  let state = build.get()
  const paint = () => {
    const status = buildStatus(state, Date.now())
    card.dataset.tone = status.tone
    card.dataset.connection = state.connection
    stateChip.textContent = state.update.applying ? "Updating" : CHIPS[status.tone]
    if (state.update.error && state.update.available) stateChip.textContent = "Update failed"
    else if (status.tone === "failed") stateChip.textContent = "Build failed"
    pr.hidden = !state.pr
    if (state.pr) {
      pr.href = state.pr.url
      if (pr.dataset.number !== String(state.pr.number)) {
        pr.dataset.number = String(state.pr.number)
        pr.replaceChildren(el("span", "", `PR #${state.pr.number}`))
        pr.insertAdjacentHTML("beforeend", EXTERNAL)
      }
    }

    const { current, latest, build: event, checks } = state
    row("tab", current, (dd) => {
      dd.append(joined(line("msh-preview-main"), sha(current.version)))
      dd.append(
        joined(
          line(),
          clock.time(current.builtAt, (r) => `built ${r}`),
        ),
      )
    })
    const next = nextVersion(state)
    row("latest", { latest, next }, (dd) => {
      if (!latest) {
        dd.append(el("span", "msh-preview-main msh-preview-none", "None reported yet"))
        return
      }
      if (!next) {
        const main = el("span", "msh-preview-main msh-preview-ok")
        main.innerHTML = CHECK
        main.append(el("span", "", "This tab is up to date"))
        dd.append(main)
      } else {
        const main = joined(line("msh-preview-main"), sha(latest.version))
        main.append(el("span", "msh-new", "New"))
        dd.append(main)
      }
      dd.append(
        joined(
          line(),
          clock.time(latest.at, (r) => `deployed ${r}`),
        ),
      )
    })
    row("build", event ?? null, (dd) => {
      if (!event) {
        dd.append(el("span", "msh-preview-main msh-preview-none", "No build reported yet"))
        return
      }
      const tone = event.state === "building" ? "busy" : event.state === "failed" ? "failed" : "ok"
      const label = { building: "Building", deployed: "Deployed", failed: "Failed" }[event.state]
      dd.append(joined(line("msh-preview-main"), chip(tone, label), sha(event.version)))
      dd.append(
        joined(
          line(),
          clock.time(event.at),
          event.url
            ? link(event.url, "View run", `View build run for ${shortSha(event.version)}`)
            : undefined,
        ),
      )
      if (event.message) {
        const reason = line("msh-preview-reason")
        reason.textContent = event.message
        dd.append(reason)
      }
    })
    row("checks", checks ?? null, (dd) => {
      if (!checks) {
        dd.append(el("span", "msh-preview-main msh-preview-none", "No checks reported yet"))
        return
      }
      const tone = checks.state === "running" ? "busy" : checks.state === "failed" ? "failed" : "ok"
      const label = { running: "Running", passed: "Passed", failed: "Failed" }[checks.state]
      dd.append(
        joined(
          line("msh-preview-main"),
          chip(tone, label),
          checks.summary ? el("span", "msh-preview-summary", checks.summary) : sha(checks.version),
        ),
      )
      dd.append(
        joined(
          line(),
          clock.time(checks.at),
          checks.url
            ? link(checks.url, "View checks", `View checks for ${shortSha(checks.version)}`)
            : undefined,
        ),
      )
    })
    row("connection", { connection: state.connection, checkedAt: state.checkedAt }, (dd) => {
      const main = el("span", "msh-preview-main msh-conn")
      main.dataset.connection = state.connection
      main.append(el("span", "msh-conn-dot"))
      main.append(
        state.connection === "live"
          ? "Live"
          : state.connection === "polling"
            ? "Polling every 15 s"
            : "Offline",
      )
      dd.append(main)
      const checked = state.checkedAt
      const offline = state.connection === "offline"
      if (checked)
        dd.append(
          joined(
            line(),
            clock.time(checked, (r) => (offline ? `last checked ${r}` : `checked ${r}`)),
          ),
        )
      else
        dd.append(
          el(
            "span",
            "msh-preview-sub",
            state.connection === "live" ? "Updates arrive as they happen" : "Not reached yet",
          ),
        )
    })

    error.hidden = !(state.update.available && state.update.error)
    error.replaceChildren()
    if (!error.hidden) {
      error.innerHTML = ALERT
      error.append(
        el("span", "", `Couldn't update to ${shortSha(next ?? "")}: ${state.update.error}`),
      )
    }
    auto.setAttribute("aria-checked", String(state.update.auto))
    updateNow.disabled = !state.update.available || state.update.applying
    updateNow.setAttribute("aria-busy", String(state.update.applying))
    updateLabel.textContent = state.update.applying
      ? "Updating…"
      : state.update.error && state.update.available
        ? "Retry update"
        : "Update now"
  }
  auto.onclick = () => build.setAutoUpdate(!state.update.auto)
  updateNow.onclick = () => {
    void build.applyUpdate().catch(() => {
      /* Reported through `update.error`. */
    })
  }
  const unsubscribe = build.subscribe((next) => {
    state = next
    paint()
  })
  paint()
  return {
    element: card,
    dispose() {
      unsubscribe()
      clock.dispose()
    },
  }
}

/** Styles for the dot, the toast and the Preview card; appended to the System screen's. */
export const BUILD_CSS = `
.msh-switcher .msh-build-dot{position:absolute;top:-7px;right:-7px;width:20px;height:20px;padding:0;border-radius:50%;background:transparent;--msh-ring:#89a0ff}
.msh-switcher .msh-build-dot:hover,.msh-switcher .msh-build-dot:active{background:transparent}
.msh-build-dot::before{content:"";position:absolute;inset:4px;border-radius:50%;background:var(--msh-tone);box-shadow:0 0 0 2px #17212f}
.msh-build-dot::after{content:"";position:absolute;inset:4px;border-radius:50%;pointer-events:none}
.msh-switcher .msh-build-dot:hover::before{box-shadow:0 0 0 2px #17212f,0 0 0 4px color-mix(in srgb,var(--msh-tone) 45%,transparent)}
.msh-build-dot[data-tone=ok],.msh-tip-tone[data-tone=ok]{--msh-tone:#3ddc84}
.msh-build-dot[data-tone=ok][data-live=true]::after{animation:msh-ping 2.4s cubic-bezier(0,0,.2,1) infinite;box-shadow:0 0 0 0 #3ddc84}
.msh-build-dot[data-tone=building],.msh-tip-tone[data-tone=building]{--msh-tone:#f5b544}
.msh-build-dot[data-tone=building]::after{inset:0;border:2px solid #f5b544;border-right-color:transparent;border-bottom-color:transparent;animation:msh-spin .9s linear infinite}
.msh-build-dot[data-tone=ready],.msh-tip-tone[data-tone=ready]{--msh-tone:#7b93ff}
.msh-build-dot[data-tone=ready]::after{inset:1px;border:1.5px solid #7b93ff;opacity:.7}
.msh-build-dot[data-tone=failed],.msh-tip-tone[data-tone=failed]{--msh-tone:#ff6b74}
.msh-build-dot[data-tone=offline],.msh-tip-tone[data-tone=offline]{--msh-tone:#8a93a3}
.msh-build-dot[data-tone=offline]::before{background:#17212f;box-shadow:inset 0 0 0 2px #8a93a3,0 0 0 2px #17212f}
.msh-tip-tone{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;vertical-align:0;background:var(--msh-tone)}

.msh-toast{position:absolute;pointer-events:auto;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;width:max-content;padding:10px 10px 10px 14px;border-radius:12px;border:1px solid #ffffff24;background:#17212f;color:#fff;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 30px #0006,0 2px 6px #0003;--msh-ring:#89a0ff;animation:msh-toast-in .18s ease-out}
.msh-toast-mark{flex:none;width:8px;height:8px;border-radius:50%;background:#7b93ff;box-shadow:0 0 0 3px #7b93ff40}
.msh-toast[data-mode=applying] .msh-toast-mark{width:14px;height:14px;background:transparent;box-shadow:none;border:2px solid #ffffff33;border-top-color:#7b93ff;animation:msh-spin .8s linear infinite}
.msh-toast[data-mode=error] .msh-toast-mark{background:#ff6b74;box-shadow:0 0 0 3px #ff6b7440}
.msh-toast-text{flex:1 1 160px;min-width:0;margin:0;color:#cfd6e2}
.msh-toast-text strong{font-weight:600;color:#fff}
.msh-toast-countdown{font-variant-numeric:tabular-nums}
.msh-toast-actions{display:flex;gap:6px;margin-left:auto}
.msh-toast-btn{min-height:30px;padding:5px 11px;border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.msh-toast-later{background:transparent;color:#cfd6e2}
.msh-toast-later:hover{background:#ffffff1a;color:#fff}
.msh-toast-now{background:#7b93ff;color:#0b1020}
.msh-toast-now:hover{background:#93a6ff}

.msh-preview{display:grid;gap:14px;padding:18px;border-top:3px solid var(--msh-state,var(--msh-ok))}
.msh-preview[data-tone=ok]{--msh-state:var(--msh-ok);--msh-state-soft:var(--msh-ok-soft)}
.msh-preview[data-tone=building]{--msh-state:var(--msh-warn);--msh-state-soft:var(--msh-warn-soft)}
.msh-preview[data-tone=ready]{--msh-state:var(--msh-accent);--msh-state-soft:var(--msh-accent-soft)}
.msh-preview[data-tone=failed]{--msh-state:var(--msh-danger);--msh-state-soft:var(--msh-danger-soft)}
.msh-preview[data-tone=offline]{--msh-state:var(--msh-off);--msh-state-soft:var(--msh-off-soft)}
.msh-preview[data-tone=ok][data-connection=live] .msh-preview-head .msh-dot{animation:msh-pulse 2s ease-in-out infinite}
.msh-preview[data-tone=building] .msh-preview-head .msh-dot{animation:msh-pulse 1.2s ease-in-out infinite}
.msh-preview-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.msh-preview-head .msh-access-title{flex:none}
.msh-preview-pr{margin-left:auto}
.msh-preview-pr,.msh-preview-link{display:inline-flex;align-items:center;gap:4px;border-radius:4px;color:var(--msh-accent);font-weight:550;text-decoration:none}
.msh-preview-pr{font-size:13px}
.msh-preview-pr:hover,.msh-preview-link:hover{text-decoration:underline;text-underline-offset:3px}
.msh-preview-pr .msh-icon,.msh-preview-link .msh-icon{width:13px;height:13px}
.msh-preview-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0}
.msh-preview-item{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;border-radius:8px;background:var(--msh-bg);border:1px solid var(--msh-line)}
.msh-preview-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--msh-faint)}
.msh-preview-value{display:grid;gap:3px;margin:0;min-width:0}
.msh-preview-main{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;font-weight:550;min-height:22px}
.msh-preview-sub{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;font-size:12.5px;color:var(--msh-muted)}
.msh-preview-sub time{font-variant-numeric:tabular-nums}
.msh-preview-none{color:var(--msh-muted);font-weight:500}
.msh-preview-ok{flex-wrap:nowrap;align-items:flex-start;color:var(--msh-ok)}.msh-preview-ok .msh-icon{width:15px;height:15px;margin-top:3px}
.msh-preview-reason{font-size:12.5px;color:var(--msh-danger)}
.msh-preview-summary{font-size:13px}
.msh-sep{color:var(--msh-faint)}.msh-sep-group{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.msh-sha{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:1px 6px;border-radius:5px;background:var(--msh-card);border:1px solid var(--msh-line);color:var(--msh-text)}
.msh-new{padding:0 7px;border-radius:999px;font-size:11px;font-weight:650;background:var(--msh-accent-soft);color:var(--msh-accent)}
.msh-state-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.msh-state-ok{background:var(--msh-ok-soft);color:var(--msh-ok)}
.msh-state-busy{background:var(--msh-warn-soft);color:var(--msh-warn)}
.msh-state-failed{background:var(--msh-danger-soft);color:var(--msh-danger)}
.msh-spinner{width:10px;height:10px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:msh-spin .8s linear infinite}
.msh-conn-dot{width:8px;height:8px;border-radius:50%;background:var(--msh-off)}
.msh-conn[data-connection=live] .msh-conn-dot{background:var(--msh-ok);animation:msh-ping-soft 2.4s cubic-bezier(0,0,.2,1) infinite}
.msh-conn[data-connection=polling] .msh-conn-dot{background:var(--msh-warn)}
.msh-conn[data-connection=offline] .msh-conn-dot{background:transparent;box-shadow:inset 0 0 0 2px var(--msh-off)}
.msh-preview-error{padding:8px 10px;border-radius:8px;background:var(--msh-danger-soft)}
.msh-preview-error .msh-icon{flex:none}
.msh-preview-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding-top:14px;border-top:1px solid var(--msh-line)}
.msh-preview-auto{text-align:left}
.msh-preview-auto-text{display:grid}
.msh-preview-auto-label{font-weight:600;color:var(--msh-text)}
.msh-preview-auto-hint{font-size:12.5px;color:var(--msh-muted)}
.msh-btn-primary{background:var(--msh-accent);color:var(--msh-accent-text)}
.msh-btn-primary:hover:not(:disabled){background:var(--msh-accent-hover)}
.msh-btn-primary:disabled{background:var(--msh-seg-bg);color:var(--msh-muted);border-color:var(--msh-line);opacity:1}
.msh-preview-update .msh-icon{width:15px;height:15px}
.msh-preview-update[aria-busy=true] .msh-icon{animation:msh-spin .8s linear infinite}
@keyframes msh-ping{0%{box-shadow:0 0 0 0 #3ddc84aa}80%,100%{box-shadow:0 0 0 7px #3ddc8400}}
@keyframes msh-ping-soft{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--msh-ok) 55%,transparent)}80%,100%{box-shadow:0 0 0 6px color-mix(in srgb,var(--msh-ok) 0%,transparent)}}
@keyframes msh-toast-in{from{transform:translateY(6px) scale(.98)}}
@media (max-width:1000px){.msh-preview-grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
@media (max-width:560px){
.msh-preview{padding:16px}
.msh-preview-grid{grid-template-columns:minmax(0,1fr);gap:0;border-top:1px solid var(--msh-line)}
.msh-preview-item{flex-direction:row;gap:12px;padding:10px 0;border:0;border-bottom:1px solid var(--msh-line);border-radius:0;background:transparent}
.msh-preview-label{flex:none;width:118px;padding-top:3px}
.msh-preview-value{flex:1}
.msh-preview-foot{border-top:0;padding-top:0}
.msh-preview-update{flex:1}
}
`
