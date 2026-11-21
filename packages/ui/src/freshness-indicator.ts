/// <reference lib="dom" />

/**
 * Freshness in the shell: tells an open tab when a newer build of its app is building, live or
 * failed. Fed structurally by `watchFreshness()` from `@crvouga/mockingbird-preview`.
 *
 * - `freshnessView(value, now)`: a pure view model (tone, headline, detail, actions).
 * - `mountFreshnessIndicator(host, options)`: a quiet dot with one line and the actions
 *   Update now, What changed and Keep this version, for the System screen or any page.
 * - `freshnessBuild(options)`: the same signal as a `SystemBuild`, so `mountSystemHarness(…, { build })`
 *   shows it as the switcher's dot, the update toast and the System screen's Preview card.
 */

import { ago, type SystemBuild, type SystemBuildState, shortSha } from "./system-build-status.js"

/** The build a tab runs (structurally `BuildIdentity`). */
export type FreshnessIdentity = { commit: string; builtAt: string; parts: Record<string, string> }
/** The next build (structurally `FreshnessNext`). */
export type FreshnessNextBuild = {
  state: "queued" | "building" | "publishing" | "failed"
  commit: string
  startedAt: string
  run: string
}
/** How to take a newer build: one app's part, or a reload of the shell. */
export type FreshnessUpdatePlan = { kind: "app"; app: string } | { kind: "reload" }
/** What a tab knows about its build (structurally `Freshness`). */
export type FreshnessValue =
  | { state: "current"; running: FreshnessIdentity; changed: [] }
  | {
      state: "newer-live"
      running: FreshnessIdentity
      current: FreshnessIdentity
      changed: string[]
      update: FreshnessUpdatePlan
      next?: FreshnessNextBuild
    }
  | { state: "newer-building"; running: FreshnessIdentity; next: FreshnessNextBuild; changed: null }
  | { state: "newer-failed"; running: FreshnessIdentity; next: FreshnessNextBuild; changed: null }
  | {
      state: "unknown"
      running: FreshnessIdentity
      changed: null
      reason: string
      retryInMs: number
    }

/** A live freshness value (`watchFreshness()` is one). */
export type FreshnessFeed = {
  get(): FreshnessValue
  subscribe(listener: (value: FreshnessValue) => void): () => void
  /** Optional: compare against a new running build after an update. */
  setRunning?(identity: FreshnessIdentity): void
}

export type FreshnessTone = "ok" | "building" | "ready" | "failed" | "offline"

export type FreshnessView = {
  /** False when there is nothing to say (current, or kept). */
  visible: boolean
  tone: FreshnessTone
  headline: string
  detail?: string
  /** The CI run of the next build. */
  log?: string
  /** Offered for a newer live build. */
  update?: { label: string; plan: FreshnessUpdatePlan }
  /** The commit range "What changed" covers. */
  range?: { from: string; to: string }
  /** "Keep this version" hides the line until a different build. */
  keepable: boolean
}

const appList = (apps: string[]) =>
  apps.length <= 3 ? apps.join(", ") : `${apps.slice(0, 3).join(", ")} and ${apps.length - 3} more`

/** What the indicator says for `value` at `now`. `kept` is the commit the person chose to keep. */
export function freshnessView(value: FreshnessValue, now: number, kept?: string): FreshnessView {
  switch (value.state) {
    case "current":
      return {
        visible: false,
        tone: "ok",
        headline: "This tab runs the current build",
        keepable: false,
      }
    case "unknown":
      return {
        visible: true,
        tone: "offline",
        headline: "Can't check for a newer build",
        detail: `Retrying in ${Math.max(1, Math.round(value.retryInMs / 1000))} s. This version keeps working.`,
        keepable: false,
      }
    case "newer-building":
      return {
        visible: kept !== value.next.commit,
        tone: "building",
        headline: `A newer build (${shortSha(value.next.commit)}) is building`,
        detail: `Started ${ago(value.next.startedAt, now)}.`,
        ...(value.next.run ? { log: value.next.run } : {}),
        keepable: false,
      }
    case "newer-failed":
      return {
        visible: kept !== value.next.commit,
        tone: "failed",
        headline: `The newer build (${shortSha(value.next.commit)}) failed`,
        detail: "This version keeps working.",
        ...(value.next.run ? { log: value.next.run } : {}),
        keepable: true,
      }
    case "newer-live": {
      const { changed, update } = value
      const detail =
        changed.length === 0 ? "Only the shell changed." : `Changed: ${appList(changed)}.`
      return {
        visible: kept !== value.current.commit,
        tone: "ready",
        headline: `A newer build (${shortSha(value.current.commit)}) is live`,
        detail,
        update: {
          label: update.kind === "app" ? `Update ${update.app}` : "Update now",
          plan: update,
        },
        range: { from: value.running.commit, to: value.current.commit },
        keepable: true,
      }
    }
  }
}

/** The commit that "Keep this version" dismisses for `value`. */
const keptCommit = (value: FreshnessValue) =>
  value.state === "newer-live"
    ? value.current.commit
    : value.state === "newer-failed" || value.state === "newer-building"
      ? value.next.commit
      : undefined

export const FRESHNESS_CSS = `
.mbf{--mbf-text:#14181f;--mbf-muted:#5b6576;--mbf-line:#e3e6eb;--mbf-card:#fff;--mbf-accent:#3451d1;--mbf-ok:#14803c;--mbf-warn:#a15c07;--mbf-danger:#bf2530;--mbf-off:#6b7483;--mbf-ring:#3451d1;color-scheme:light dark;display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--mbf-line);border-radius:10px;background:var(--mbf-card);color:var(--mbf-text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){.mbf{--mbf-text:#e7eaf0;--mbf-muted:#a0a8b6;--mbf-line:#262c36;--mbf-card:#161a21;--mbf-accent:#6f8cff;--mbf-ok:#4ad07f;--mbf-warn:#f0b357;--mbf-danger:#ff7b84;--mbf-off:#8d96a5;--mbf-ring:#89a0ff}}
.mbf[hidden]{display:none}
.mbf-dot{flex:none;width:9px;height:9px;margin-top:6px;border-radius:50%;background:var(--mbf-off)}
.mbf[data-tone=ready] .mbf-dot{background:var(--mbf-accent)}
.mbf[data-tone=building] .mbf-dot{background:var(--mbf-warn);animation:mbf-pulse 1.6s ease-in-out infinite}
.mbf[data-tone=failed] .mbf-dot{background:var(--mbf-danger)}
.mbf[data-tone=ok] .mbf-dot{background:var(--mbf-ok)}
@keyframes mbf-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.mbf-dot{animation:none!important}}
.mbf-body{flex:1;min-width:0}
.mbf-headline{margin:0;font-weight:600}
.mbf-detail{margin:2px 0 0;color:var(--mbf-muted);font-size:13px;overflow-wrap:anywhere}
.mbf-actions{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px}
.mbf-actions[hidden]{display:none}
.mbf-btn,.mbf-link{font:inherit;font-size:13px;font-weight:600;color:var(--mbf-accent);background:none;border:0;padding:4px 0;cursor:pointer;text-decoration:none}
.mbf-btn-primary{padding:4px 10px;border-radius:7px;background:var(--mbf-accent);color:#fff}
@media (prefers-color-scheme:dark){.mbf-btn-primary{color:#0b1020}}
.mbf-btn:disabled{opacity:.6;cursor:default}
.mbf :focus-visible{outline:2px solid var(--mbf-ring);outline-offset:2px;border-radius:4px}
`

export type FreshnessIndicatorOptions = {
  freshness: FreshnessFeed
  /** Applies a newer live build: swap one app's part (#838) or reload the shell. Default: `location.reload()`. */
  onUpdate?(plan: FreshnessUpdatePlan, value: FreshnessValue): void | Promise<void>
  /** The address of the commit range, for "What changed". Without it the link is not shown. */
  compareUrl?(from: string, to: string): string
  /** Clock in ms. Default `Date.now`. */
  now?: () => number
}

/** A quiet dot and one line saying whether a newer build is building, live or failed. */
export function mountFreshnessIndicator(host: HTMLElement, options: FreshnessIndicatorOptions) {
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  const now = options.now ?? Date.now
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = doc.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const style = doc.createElement("style")
  style.textContent = FRESHNESS_CSS
  const root = el("div", "mbf")
  root.dataset.testid = "freshness"
  root.setAttribute("role", "status")
  root.setAttribute("aria-live", "polite")
  const dot = el("span", "mbf-dot")
  dot.setAttribute("aria-hidden", "true")
  const body = el("div", "mbf-body")
  const headline = el("p", "mbf-headline")
  const detail = el("p", "mbf-detail")
  const actions = el("div", "mbf-actions")
  const update = el("button", "mbf-btn mbf-btn-primary")
  update.type = "button"
  update.dataset.testid = "freshness-update"
  const changes = el("a", "mbf-link", "What changed")
  changes.target = "_blank"
  changes.rel = "noreferrer"
  changes.dataset.testid = "freshness-changes"
  const log = el("a", "mbf-link", "Build log")
  log.target = "_blank"
  log.rel = "noreferrer"
  log.dataset.testid = "freshness-log"
  const keep = el("button", "mbf-btn", "Keep this version")
  keep.type = "button"
  keep.dataset.testid = "freshness-keep"
  actions.append(update, changes, log, keep)
  body.append(headline, detail, actions)
  root.append(dot, body)
  host.append(style, root)

  let value = options.freshness.get()
  let kept: string | undefined
  let applying = false
  let view = freshnessView(value, now())
  const paint = () => {
    view = freshnessView(value, now(), kept)
    root.hidden = !view.visible
    root.dataset.tone = view.tone
    root.dataset.state = value.state
    headline.textContent = view.headline
    detail.textContent = view.detail ?? ""
    detail.hidden = !view.detail
    update.hidden = !view.update
    update.disabled = applying
    update.textContent = applying ? "Updating…" : (view.update?.label ?? "")
    const range = view.range && options.compareUrl?.(view.range.from, view.range.to)
    changes.hidden = !range
    if (range) changes.href = range
    log.hidden = !view.log
    if (view.log) log.href = view.log
    keep.hidden = !view.keepable
    actions.hidden = [update, changes, log, keep].every((node) => node.hidden)
  }
  update.onclick = async () => {
    if (!view.update || applying) return
    applying = true
    paint()
    try {
      if (options.onUpdate) await options.onUpdate(view.update.plan, value)
      else win.location.reload()
    } finally {
      applying = false
      paint()
    }
  }
  keep.onclick = () => {
    kept = keptCommit(value)
    paint()
  }
  const unsubscribe = options.freshness.subscribe((next) => {
    value = next
    paint()
  })
  // "Started 2 min ago" stays true without a new value.
  const timer = win.setInterval(paint, 15_000)
  paint()
  return {
    element: root,
    destroy() {
      unsubscribe()
      win.clearInterval(timer)
      root.remove()
      style.remove()
    },
  }
}

export type FreshnessBuildOptions = {
  freshness: FreshnessFeed
  /** Applies a newer live build; it resolves once the tab runs it. Default: `location.reload()`. */
  onUpdate?(plan: FreshnessUpdatePlan, value: FreshnessValue): void | Promise<void>
  /** The PR the preview belongs to, for the Preview card's link. */
  pr?: { number: number; url: string }
  /** Apply newer live builds at once. Default false. */
  auto?: boolean
}

/**
 * Freshness as a `SystemBuild`: pass it to `mountSystemHarness(…, { build })` for the switcher's
 * dot, the update toast (Update now / Not now = keep this version) and the System screen's card.
 */
export function freshnessBuild(options: FreshnessBuildOptions): SystemBuild & { destroy(): void } {
  const listeners = new Set<(state: SystemBuildState) => void>()
  let value = options.freshness.get()
  let auto = options.auto ?? false
  let applying = false
  let error: string | undefined
  let checkedAt = new Date().toISOString()
  const project = (): SystemBuildState => {
    const { running } = value
    const latest = value.state === "newer-live" ? value.current : running
    const next =
      value.state === "newer-building" || value.state === "newer-failed" ? value.next : undefined
    return {
      current: { version: running.commit, builtAt: running.builtAt },
      latest: { version: latest.commit, at: latest.builtAt },
      ...(next
        ? {
            build: {
              state: next.state === "failed" ? "failed" : "building",
              version: next.commit,
              at: next.startedAt,
              ...(next.run ? { url: next.run } : {}),
              ...(next.state === "failed"
                ? { message: "The newer build failed; this version keeps working." }
                : {}),
            },
          }
        : value.state === "newer-live"
          ? { build: { state: "deployed", version: latest.commit, at: latest.builtAt } }
          : {}),
      connection: value.state === "unknown" ? "offline" : "polling",
      checkedAt,
      update: {
        available: value.state === "newer-live",
        applying,
        auto,
        ...(error ? { error } : {}),
      },
      ...(options.pr ? { pr: options.pr } : {}),
    }
  }
  let state = project()
  const emit = () => {
    state = project()
    for (const listener of listeners) listener(state)
  }
  const applyUpdate = async () => {
    if (value.state !== "newer-live" || applying) return
    applying = true
    error = undefined
    emit()
    try {
      if (options.onUpdate) await options.onUpdate(value.update, value)
      else window.location.reload()
      options.freshness.setRunning?.(value.current)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The update failed."
    } finally {
      applying = false
      emit()
    }
  }
  const unsubscribe = options.freshness.subscribe((next) => {
    const fresh =
      next.state === "newer-live" &&
      (value.state !== "newer-live" || value.current.commit !== next.current.commit)
    value = next
    if (next.state !== "unknown") checkedAt = new Date().toISOString()
    if (fresh) error = undefined
    emit()
    if (fresh && auto) void applyUpdate()
  })
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    applyUpdate,
    postpone() {
      // The toast's "Not now" keeps this version; the card's Update now still applies it.
    },
    setAutoUpdate(on) {
      auto = on
      emit()
      if (on) void applyUpdate()
    },
    destroy() {
      unsubscribe()
      listeners.clear()
    },
  }
}
