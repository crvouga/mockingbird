/// <reference lib="dom" />

/**
 * The launcher page every pull request can link to before anything is built. It polls an
 * on-demand build relay (`GET <relay>?pr=<n>`, a `PreviewLaunch`), starts the build of the head
 * commit (`POST <relay>?pr=<n>`) exactly once, shows the build live and opens the preview when it
 * is ready. Dependency-free; `@crvouga/mockingbird-preview`'s `createBuildRelay()` is one relay.
 */

import {
  type LauncherInput,
  type LauncherView,
  launcherView,
  matchLauncherPath,
  parseLaunch,
  pollInterval,
  READY_DELAY_MS,
} from "./preview-launcher-view.js"

export {
  formatElapsed,
  type LauncherInput,
  type LauncherPhase,
  type LauncherState,
  type LauncherStepView,
  type LauncherView,
  launcherView,
  matchLauncherPath,
  POLL,
  PROGRESS_CAP,
  type PreviewLaunch,
  type PreviewLaunchBase,
  type PreviewLaunchRun,
  type PreviewLaunchStep,
  parseLaunch,
  pollInterval,
  READY_DELAY_MS,
  shortCommit,
  stepLabel,
} from "./preview-launcher-view.js"

/** Timers the launcher schedules on; injected in tests. */
export type LauncherTimers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** What the controller knows now. */
export type LauncherSnapshot = {
  input: LauncherInput
  /** When this page saw the build start (ms), for elapsed time before the relay has a run. */
  startedAt?: number
}

export type LauncherControllerOptions = {
  pullRequest: number
  /** The relay's address; requests go to `<relay>?pr=<n>` (an existing query string is kept). */
  relay: string
  fetch?: typeof fetch
  /** Stay on Ready with an Open button and keep watching, instead of opening the preview. */
  stay?: boolean
  now?: () => number
  timers?: LauncherTimers
  /** True while the page is hidden: polling pauses. */
  hidden?: () => boolean
  onChange(snapshot: LauncherSnapshot): void
  /** Opens the preview, `READY_DELAY_MS` after Ready (never when `stay`). */
  onLive(url: string): void
}

export type LauncherController = {
  /** Fetches the state now. */
  refresh(): void
  /** Refetches when the state polls (after the page was hidden or lost focus). */
  resume(): void
  /** Stops polling until `resume()`. */
  pause(): void
  /** Starts a build again (Try again). */
  retry(): void
  get(): LauncherSnapshot
  destroy(): void
}

/** The relay address for `pullRequest`, keeping any query string and hash on `relay`. */
export function launcherRequestUrl(relay: string, pullRequest: number): string {
  const hash = relay.indexOf("#")
  const base = hash === -1 ? relay : relay.slice(0, hash)
  const separator = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?"
  return `${base}${separator}pr=${pullRequest}`
}

/**
 * Head commits a start was sent for, per relay and pull request: module-wide, so a second mount
 * (React StrictMode, a rerender) never starts the same commit twice. A failed start clears it.
 */
const STARTED = new Set<string>()

const BUSY = "Too many previews are building right now. Trying again shortly."

const defaultTimers: LauncherTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The launcher's polling and start logic, without a DOM. */
export function createLauncherController(options: LauncherControllerOptions): LauncherController {
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const now = options.now ?? Date.now
  const timers = options.timers ?? defaultTimers
  const hidden = options.hidden ?? (() => false)
  const url = launcherRequestUrl(options.relay, options.pullRequest)
  const key = (head: string | undefined) =>
    `${options.relay}\n${options.pullRequest}\n${head ?? ""}`

  let input: LauncherInput = { state: "loading" }
  let startedAt: number | undefined
  let poll: unknown
  let redirect: unknown
  let redirected: string | undefined
  let seq = 0
  let destroyed = false
  /** The last head commit the relay named, for Try again from a state that names none. */
  let head: string | undefined

  const starting = () => input.state === "idle" && STARTED.has(key(input.head))
  const snapshot = (): LauncherSnapshot => ({
    input,
    ...(startedAt === undefined ? {} : { startedAt }),
  })

  const request = async (
    method: "GET" | "POST",
  ): Promise<{ ok: boolean; input: LauncherInput }> => {
    try {
      const response = await fetcher(url, {
        method,
        headers: { accept: "application/json" },
        cache: "no-store",
      })
      const body: unknown = await response.json().catch(() => undefined)
      const launch = parseLaunch(body, options.pullRequest)
      if (response.status === 429)
        return {
          ok: false,
          input: { state: "busy", message: launch && "message" in launch ? launch.message : BUSY },
        }
      if (!response.ok || !launch) return { ok: false, input: { state: "reconnecting" } }
      return { ok: true, input: launch }
    } catch {
      return { ok: false, input: { state: "reconnecting" } }
    }
  }

  const clearPoll = () => {
    if (poll !== undefined) timers.clearTimeout(poll)
    poll = undefined
  }
  const schedule = () => {
    clearPoll()
    if (destroyed || hidden()) return
    const ms = pollInterval(input, { stay: options.stay ?? false, starting: starting() })
    if (ms === undefined) return
    poll = timers.setTimeout(() => {
      poll = undefined
      load()
    }, ms)
  }

  const start = (head: string | undefined, force = false) => {
    const marker = key(head)
    if (STARTED.has(marker) && !force) return
    STARTED.add(marker)
    const id = ++seq
    void request("POST").then((result) => {
      if (!result.ok) STARTED.delete(marker)
      if (destroyed) return
      if (id === seq) apply(result.input)
      else schedule()
    })
  }

  function apply(next: LauncherInput) {
    if (destroyed) return
    input = next
    if ("head" in next && next.head) head = next.head
    switch (next.state) {
      case "idle":
      case "queued":
      case "building":
      case "publishing":
        startedAt ??= now()
        break
      case "reconnecting":
      case "busy":
      case "loading":
        break
      default:
        startedAt = undefined
    }
    if (next.state === "idle") start(next.head)
    if (next.state === "live" && !options.stay && redirected !== next.url) {
      redirected = next.url
      const target = next.url
      redirect = timers.setTimeout(() => {
        redirect = undefined
        if (!destroyed) options.onLive(target)
      }, READY_DELAY_MS)
    }
    options.onChange(snapshot())
    schedule()
  }

  function load() {
    if (destroyed) return
    clearPoll()
    const id = ++seq
    void request("GET").then((result) => {
      if (id === seq) apply(result.input)
    })
  }

  return {
    refresh: load,
    resume() {
      if (pollInterval(input, { stay: options.stay ?? false, starting: starting() }) !== undefined)
        load()
    },
    pause: clearPoll,
    retry() {
      if (destroyed) return
      if (input.state === "failed" || input.state === "busy" || input.state === "idle")
        start(head, true)
      else load()
    },
    get: snapshot,
    destroy() {
      destroyed = true
      seq++
      clearPoll()
      if (redirect !== undefined) timers.clearTimeout(redirect)
      redirect = undefined
    },
  }
}

export type PreviewLauncherOptions = {
  pullRequest: number
  /** The relay's address, e.g. `/api/preview` or `https://relay.example/launch`. */
  relay: string
  fetch?: typeof fetch
  /** Opens the live preview. Default `location.replace(url)`. */
  onLive?: (url: string) => void
  /** Stay on Ready with an Open button and keep watching for newer commits. */
  stay?: boolean
  now?: () => number
  timers?: LauncherTimers
}

export type PreviewLauncher = {
  /** Fetches the state now. */
  refresh(): void
  /** Starts the build again (what Try again does). */
  retry(): void
  destroy(): void
}

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const ICONS = {
  done: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  failed: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
  skipped: svg('<path d="M6 12h12"/>'),
  pending: svg('<circle cx="12" cy="12" r="3"/>'),
  running: '<span class="mpl-spin" aria-hidden="true"></span>',
  external: svg(
    '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  ),
}
const STEP_WORDS = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
} as const

/**
 * Mounts the launcher into `host` and starts watching. Polling adapts to the state, pauses while
 * the page is hidden and refetches when it is shown or focused again.
 */
export function mountPreviewLauncher(
  host: HTMLElement,
  options: PreviewLauncherOptions,
): PreviewLauncher {
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  const now = options.now ?? Date.now
  const timers = options.timers ?? defaultTimers
  const stay = options.stay ?? false
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    testid?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag)
    node.className = className
    if (testid) node.dataset.testid = testid
    return node
  }

  const root = el("div", "mpl", "preview-launcher")
  const style = doc.createElement("style")
  style.textContent = PREVIEW_LAUNCHER_CSS
  const card = el("main", "mpl-card")
  const top = el("p", "mpl-top")
  const title = el("span", "mpl-title", "preview-launcher-title")
  const commit = el("code", "mpl-commit", "preview-launcher-commit")
  top.append(title, commit)
  const status = el("div", "mpl-status", "preview-launcher-status")
  status.setAttribute("aria-live", "polite")
  status.setAttribute("aria-atomic", "true")
  const headline = el("h1", "mpl-headline", "preview-launcher-headline")
  const detail = el("p", "mpl-detail", "preview-launcher-detail")
  status.append(headline, detail)
  const phases = el("ol", "mpl-phases", "preview-launcher-phases")
  phases.setAttribute("aria-label", "Progress")
  const progress = el("div", "mpl-progress", "preview-launcher-progress")
  progress.setAttribute("role", "progressbar")
  progress.setAttribute("aria-label", "Build progress")
  const bar = el("div", "mpl-bar")
  progress.append(bar)
  const time = el("p", "mpl-time", "preview-launcher-elapsed")
  const steps = el("ol", "mpl-steps", "preview-launcher-steps")
  steps.setAttribute("aria-label", "Build steps")
  const actions = el("div", "mpl-actions")
  const open = el("a", "mpl-btn mpl-primary", "preview-launcher-open")
  const retry = el("button", "mpl-btn mpl-primary", "preview-launcher-retry")
  retry.type = "button"
  retry.textContent = "Try again"
  const current = el("a", "mpl-btn", "preview-launcher-current")
  const log = el("a", "mpl-link", "preview-launcher-log")
  log.target = "_blank"
  log.rel = "noopener noreferrer"
  log.innerHTML = `View build log ${ICONS.external}`
  actions.append(open, retry, current, log)
  card.append(top, status, phases, progress, time, steps, actions)
  root.append(style, card)
  host.append(root)

  let snapshot: LauncherSnapshot = { input: { state: "loading" } }
  let tick: unknown
  let painted = { phases: "", steps: "" }

  const setText = (node: HTMLElement, text: string | undefined) => {
    node.hidden = !text
    if (node.textContent !== (text ?? "")) node.textContent = text ?? ""
  }
  const setLink = (node: HTMLAnchorElement, link: { label: string; url: string } | undefined) => {
    node.hidden = !link
    if (!link) return
    if (node.getAttribute("href") !== link.url) node.href = link.url
    if (node.textContent !== link.label) node.textContent = link.label
  }

  const paint = () => {
    const view: LauncherView = launcherView(snapshot.input, now(), {
      stay,
      pullRequest: options.pullRequest,
      ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    })
    root.dataset.state = view.state
    root.dataset.tone = view.tone
    setText(title, view.title)
    setText(commit, view.commit)
    setText(headline, view.headline)
    setText(detail, view.detail)

    const phaseKey = JSON.stringify(view.phases ?? [])
    if (phaseKey !== painted.phases) {
      painted.phases = phaseKey
      phases.hidden = !view.phases
      phases.replaceChildren(
        ...(view.phases ?? []).map((phase) => {
          const item = el("li", "mpl-phase")
          item.dataset.phase = phase.id
          item.dataset.status = phase.status
          if (phase.status === "current") item.setAttribute("aria-current", "step")
          const mark = el("span", "mpl-phase-mark")
          mark.setAttribute("aria-hidden", "true")
          if (phase.status === "done") mark.innerHTML = ICONS.done
          const label = el("span", "mpl-phase-label")
          label.textContent = phase.label
          const sr = el("span", "mpl-sr")
          sr.textContent =
            phase.status === "done" ? " (done)" : phase.status === "current" ? " (now)" : ""
          item.append(mark, label, sr)
          return item
        }),
      )
    }

    progress.hidden = !view.progress
    if (view.progress === "indeterminate") {
      progress.dataset.mode = "indeterminate"
      progress.removeAttribute("aria-valuenow")
      bar.style.width = ""
    } else if (view.progress) {
      progress.dataset.mode = "determinate"
      progress.setAttribute("aria-valuemin", "0")
      progress.setAttribute("aria-valuemax", "100")
      progress.setAttribute("aria-valuenow", String(view.progress.percent))
      bar.style.width = `${view.progress.percent}%`
    }

    const timing = [
      view.elapsed ? `Elapsed ${view.elapsed}` : "",
      view.usually ? `usually ${view.usually}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
    setText(time, timing)

    const stepKey = JSON.stringify(view.steps)
    if (stepKey !== painted.steps) {
      painted.steps = stepKey
      steps.hidden = view.steps.length === 0
      steps.replaceChildren(
        ...view.steps.map((step) => {
          const item = el("li", "mpl-step")
          item.dataset.state = step.state
          if (step.label !== step.name) item.title = step.name
          const mark = el("span", "mpl-step-mark")
          mark.innerHTML = ICONS[step.state]
          const label = el("span", "mpl-step-label")
          label.textContent = step.label
          const word = el("span", "mpl-sr")
          word.textContent = ` (${STEP_WORDS[step.state]})`
          item.append(mark, label, word)
          return item
        }),
      )
    }

    setLink(open, view.open)
    retry.hidden = !view.retry
    setLink(current, view.current)
    log.hidden = !view.log
    if (view.log && log.getAttribute("href") !== view.log) log.href = view.log
    actions.hidden = !view.open && !view.retry && !view.current && !view.log
    // Leave focus somewhere sensible rather than on a control that just went away.
    const focused = doc.activeElement as HTMLElement | null
    if (focused && actions.contains(focused) && (focused.hidden || actions.hidden)) card.focus()

    if (view.ticking && tick === undefined)
      tick = timers.setTimeout(() => {
        tick = undefined
        paint()
      }, 1000)
  }
  card.tabIndex = -1

  const controller = createLauncherController({
    pullRequest: options.pullRequest,
    relay: options.relay,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    stay,
    now,
    timers,
    hidden: () => doc.visibilityState === "hidden",
    onChange(next) {
      snapshot = next
      paint()
    },
    onLive: options.onLive ?? ((url) => win.location.replace(url)),
  })
  retry.addEventListener("click", () => controller.retry())

  const visibility = () => {
    if (doc.visibilityState === "hidden") controller.pause()
    else controller.resume()
  }
  const focus = () => controller.resume()
  doc.addEventListener("visibilitychange", visibility)
  win.addEventListener("focus", focus)

  paint()
  controller.refresh()

  return {
    refresh: controller.refresh,
    retry: controller.retry,
    destroy() {
      controller.destroy()
      if (tick !== undefined) timers.clearTimeout(tick)
      tick = undefined
      painted = { phases: "", steps: "" }
      doc.removeEventListener("visibilitychange", visibility)
      win.removeEventListener("focus", focus)
      root.remove()
    },
  }
}

export type StartPreviewLauncherOptions = Omit<PreviewLauncherOptions, "pullRequest"> & {
  /** The path the launcher is served under. Default `/pr/`. */
  prefix?: string
  /** Default `location.pathname`. */
  pathname?: string
  /** Default `document.body`. */
  host?: HTMLElement
}

/**
 * The standalone page: reads the pull request number from `location.pathname` (`/pr/42`) and
 * mounts the launcher into the body, or says the address is not a pull request's. Put
 * `PREVIEW_LAUNCHER_HEAD` in the page's `<head>` so light and dark never flash.
 */
export function startPreviewLauncher(
  options: StartPreviewLauncherOptions,
): PreviewLauncher | undefined {
  const { prefix = "/pr/", pathname, host, ...rest } = options
  const target = host ?? document.body
  const doc = target.ownerDocument
  const pullRequest = matchLauncherPath(pathname ?? doc.location.pathname, prefix)
  if (pullRequest === undefined) {
    const root = doc.createElement("div")
    root.className = "mpl"
    root.dataset.testid = "preview-launcher"
    root.dataset.state = "not-found"
    const style = doc.createElement("style")
    style.textContent = PREVIEW_LAUNCHER_CSS
    const card = doc.createElement("main")
    card.className = "mpl-card"
    const heading = doc.createElement("h1")
    heading.className = "mpl-headline"
    heading.dataset.testid = "preview-launcher-headline"
    heading.textContent = "This is not a pull request address."
    const hint = doc.createElement("p")
    hint.className = "mpl-detail"
    hint.textContent = `Open ${prefix.endsWith("/") ? prefix : `${prefix}/`}<number>, such as ${prefix.endsWith("/") ? prefix : `${prefix}/`}42.`
    card.append(heading, hint)
    root.append(style, card)
    target.append(root)
    return undefined
  }
  if (!host) doc.title = `Preview · PR #${pullRequest}`
  return mountPreviewLauncher(target, { ...rest, pullRequest })
}

/** Styles for the launcher; every rule is under `.mpl`. */
export const PREVIEW_LAUNCHER_CSS = `
.mpl{--mpl-bg:#f4f5f7;--mpl-card:#fff;--mpl-text:#14181f;--mpl-muted:#5b6576;--mpl-faint:#8a93a3;--mpl-line:#e3e6eb;--mpl-accent:#3451d1;--mpl-accent-hover:#2a43b3;--mpl-accent-text:#fff;--mpl-accent-soft:#eceffd;--mpl-ok:#14803c;--mpl-warn:#a15c07;--mpl-danger:#bf2530;--mpl-danger-soft:#fdecec;--mpl-ring:#3451d1;--mpl-shadow:0 1px 2px rgb(16 24 40/.05),0 4px 16px rgb(16 24 40/.06);
color-scheme:light dark;box-sizing:border-box;display:grid;place-items:start center;min-height:100%;min-height:100dvh;padding:max(16px,8vh) 16px 32px;background:var(--mpl-bg);color:var(--mpl-text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){.mpl{--mpl-bg:#0e1116;--mpl-card:#161a21;--mpl-text:#e7eaf0;--mpl-muted:#a0a8b6;--mpl-faint:#737c8c;--mpl-line:#262c36;--mpl-accent:#6f8cff;--mpl-accent-hover:#89a0ff;--mpl-accent-text:#0b1020;--mpl-accent-soft:#1c2440;--mpl-ok:#4ad07f;--mpl-warn:#f0b357;--mpl-danger:#ff7b84;--mpl-danger-soft:#33161a;--mpl-ring:#89a0ff;--mpl-shadow:0 1px 2px rgb(0 0 0/.4)}}
.mpl *,.mpl *::before,.mpl *::after{box-sizing:border-box}
.mpl [hidden]{display:none!important}
.mpl :focus-visible{outline:2px solid var(--mpl-ring);outline-offset:2px}
.mpl-card{width:100%;max-width:560px;min-width:0;padding:24px;border:1px solid var(--mpl-line);border-radius:14px;background:var(--mpl-card);box-shadow:var(--mpl-shadow);outline:none}
.mpl-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 6px;color:var(--mpl-muted);font-size:13px}
.mpl-commit{padding:1px 6px;border-radius:6px;background:var(--mpl-accent-soft);color:var(--mpl-text);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.mpl-headline{margin:0;font-size:22px;line-height:1.3;font-weight:650;overflow-wrap:anywhere}
.mpl-detail{margin:6px 0 0;color:var(--mpl-muted);overflow-wrap:anywhere}
.mpl[data-tone=failed] .mpl-headline{color:var(--mpl-danger)}
.mpl-phases{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:20px 0 0;padding:0;list-style:none}
.mpl-phase{display:flex;flex-direction:column;gap:6px;min-width:0;color:var(--mpl-faint);font-size:12px;font-weight:550}
.mpl-phase::before{content:"";display:block;height:4px;border-radius:2px;background:var(--mpl-line)}
.mpl-phase[data-status=done]{color:var(--mpl-muted)}
.mpl-phase[data-status=done]::before{background:var(--mpl-ok)}
.mpl-phase[data-status=current]{color:var(--mpl-text)}
.mpl-phase[data-status=current]::before{background:var(--mpl-accent)}
.mpl-phase-mark{display:none}
.mpl-phase-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mpl-progress{position:relative;height:6px;margin:18px 0 0;overflow:hidden;border-radius:3px;background:var(--mpl-accent-soft)}
.mpl-bar{position:absolute;inset:0 auto 0 0;border-radius:inherit;background:var(--mpl-accent);transition:width .6s ease}
.mpl[data-tone=ready] .mpl-bar{background:var(--mpl-ok)}
.mpl-progress[data-mode=indeterminate] .mpl-bar{width:35%;animation:mpl-slide 1.4s ease-in-out infinite}
@keyframes mpl-slide{from{left:-35%}to{left:100%}}
.mpl-time{margin:8px 0 0;color:var(--mpl-muted);font-size:13px;font-variant-numeric:tabular-nums}
.mpl-steps{margin:16px 0 0;padding:12px 0 0;border-top:1px solid var(--mpl-line);list-style:none;display:grid;gap:6px}
.mpl-step{display:flex;align-items:center;gap:10px;min-width:0;color:var(--mpl-muted);font-size:14px}
.mpl-step[data-state=running]{color:var(--mpl-text);font-weight:550}
.mpl-step[data-state=failed]{color:var(--mpl-danger)}
.mpl-step[data-state=skipped]{color:var(--mpl-faint)}
.mpl-step-label{min-width:0;overflow-wrap:anywhere}
.mpl-step-mark{display:grid;place-items:center;flex:none;width:18px;height:18px}
.mpl-step-mark svg{width:16px;height:16px}
.mpl-step[data-state=done] .mpl-step-mark{color:var(--mpl-ok)}
.mpl-step[data-state=pending] .mpl-step-mark{color:var(--mpl-faint)}
.mpl-spin{width:14px;height:14px;border:2px solid var(--mpl-accent-soft);border-top-color:var(--mpl-accent);border-radius:50%;animation:mpl-turn .8s linear infinite}
@keyframes mpl-turn{to{transform:rotate(360deg)}}
.mpl-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0 0}
.mpl-btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;max-width:100%;padding:8px 16px;border:1px solid var(--mpl-line);border-radius:10px;background:var(--mpl-card);color:var(--mpl-text);font:inherit;font-weight:550;text-decoration:none;cursor:pointer;overflow-wrap:anywhere;text-align:center}
.mpl-btn:hover{border-color:var(--mpl-faint)}
.mpl-primary{border-color:var(--mpl-accent);background:var(--mpl-accent);color:var(--mpl-accent-text)}
.mpl-primary:hover{border-color:var(--mpl-accent-hover);background:var(--mpl-accent-hover)}
.mpl-link{display:inline-flex;align-items:center;gap:4px;min-height:40px;color:var(--mpl-accent);font-weight:550;text-decoration:none}
.mpl-link:hover{text-decoration:underline}
.mpl-link svg{width:14px;height:14px}
.mpl-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:420px){.mpl-card{padding:18px}.mpl-headline{font-size:19px}.mpl-btn{flex:1 1 100%}}
@media (prefers-reduced-motion:reduce){.mpl *,.mpl *::before,.mpl *::after{animation:none!important;transition:none!important}.mpl-progress[data-mode=indeterminate] .mpl-bar{left:0;width:100%;opacity:.35}}
`

/**
 * What a static launcher page puts in its `<head>`: the colour scheme and the page background in
 * both themes, so nothing flashes before the script runs.
 */
export const PREVIEW_LAUNCHER_HEAD = `<meta name="color-scheme" content="light dark"><style>html{color-scheme:light dark;background:#f4f5f7;color:#14181f}body{margin:0;min-height:100vh}@media (prefers-color-scheme:dark){html{background:#0e1116;color:#e7eaf0}}</style>`
