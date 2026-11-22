/**
 * What a live preview knows about its own build: the version this tab runs, the latest deployed
 * one, the build and checks of the newest commit, how it hears about them, and the pending update.
 * `@crvouga/mockingbird-preview`'s `createLivePreview()` is one source of it.
 */
export type SystemBuildState = {
  /** The version this tab runs: a commit SHA and when it was built (ISO). */
  current: { version: string; builtAt: string }
  /** The latest deployed version. */
  latest?: { version: string; at: string }
  /** The latest build event, for any commit. */
  build?: {
    state: "building" | "deployed" | "failed"
    version: string
    at: string
    url?: string
    message?: string
  }
  /** The latest CI checks event. */
  checks?: {
    state: "running" | "passed" | "failed"
    version: string
    at: string
    url?: string
    summary?: string
  }
  /** Live: a push socket; polling: the socket is down and status is fetched every 15 s. */
  connection: "live" | "polling" | "offline"
  /** The last successful contact (ISO). */
  checkedAt?: string
  update: {
    /** A newer version is deployed and its assets are live. */
    available: boolean
    applying: boolean
    /** Apply new versions on their own, after a countdown. */
    auto: boolean
    /** When the pending update applies itself (ISO); absent when it waits for the person. */
    autoApplyAt?: string
    /** Why the last update failed. */
    error?: string
    /**
     * True when the pending version resets the data this preview keeps in the tab (its
     * `stateVersion` differs). Such an update never applies on its own: the toast says why and
     * the Preview card offers Save before Update now.
     */
    resetsData?: boolean
  }
  pr?: { number: number; url: string }
}

/** A live view of the build, and the actions the switcher and the System screen offer. */
export type SystemBuild = {
  get(): SystemBuildState
  /** Calls `listener` on every change; returns the unsubscriber. */
  subscribe(listener: (state: SystemBuildState) => void): () => void
  applyUpdate(): Promise<void>
  /** Stops the countdown until the next new version. */
  postpone(): void
  setAutoUpdate(on: boolean): void
}

/** The switcher dot's colour: ok (green), building (amber), ready (blue), failed (red), offline (grey). */
export type BuildTone = "ok" | "building" | "ready" | "failed" | "offline"

/** A commit SHA as people read it. */
export const shortSha = (version: string) =>
  /^[0-9a-f]{8,}$/i.test(version) ? version.slice(0, 7) : version

/** "just now", "42 s ago", "3 min ago", "5 h ago", "2 d ago"; never negative. */
export function ago(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "at an unknown time"
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** How long until a relative time next reads differently enough to repaint: 1 s under a minute, else 15 s. */
export const tickAfter = (iso: string, now: number) =>
  now - Date.parse(iso) < 60_000 ? 1000 : 15_000

/** Whole seconds until `iso`, never below 0. */
export const secondsUntil = (iso: string, now: number) =>
  Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000))

/** The version an available update goes to. */
export const nextVersion = (state: SystemBuildState) =>
  state.latest && state.latest.version !== state.current.version ? state.latest.version : undefined

/** One line for the switcher's dot: its tone and what it says (also its tooltip). */
export function buildStatus(
  state: SystemBuildState,
  now: number,
): { tone: BuildTone; text: string } {
  const next = nextVersion(state)
  const { update, build } = state
  if (update.applying) return { tone: "ready", text: `Updating to ${shortSha(next ?? "")}…` }
  if (update.available) {
    const target = shortSha(next ?? "")
    if (update.error) return { tone: "failed", text: `Update to ${target} failed` }
    if (update.auto && update.autoApplyAt)
      return {
        tone: "ready",
        text: `New version ${target} ready · updating in ${secondsUntil(update.autoApplyAt, now)}s`,
      }
    return { tone: "ready", text: `New version ${target} ready` }
  }
  if (build?.state === "failed")
    return { tone: "failed", text: `Build for ${shortSha(build.version)} failed` }
  if (build?.state === "building" && build.version !== state.current.version)
    return { tone: "building", text: `Building ${shortSha(build.version)}` }
  if (state.connection === "offline")
    return {
      tone: "offline",
      text: state.checkedAt ? `Offline · last checked ${ago(state.checkedAt, now)}` : "Offline",
    }
  const checks = state.checks?.state === "failed" ? " · checks failed" : ""
  return {
    tone: "ok",
    text: `Up to date${checks} · ${state.connection === "live" ? "live" : "polling"}`,
  }
}
