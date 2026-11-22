/** The framework-free contracts between the System harness, its host app and its React view. */
import type { SystemBuild } from "./system-build-status.js"
import type { SystemIcon } from "./system-icons.js"

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
  /** The last request this service answered (or the dev resource did): when, and how it went. */
  lastCall?: SystemServiceCall
}

/** One request a service answered: an ISO time, whether it succeeded, and its HTTP status. */
export type SystemServiceCall = { at: string; ok: boolean; status?: number }

/** What a service's Test button reports. */
export type SystemServiceTest = { ok: boolean; message?: string }

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
  /**
   * Calls `listener` whenever a mode, an availability or a status changes outside the System
   * screen (another tab, a test harness, the proxy refusing a service); returns the unsubscribe.
   * The screen lists again and the switcher's dev badge follows.
   */
  subscribe?(listener: () => void): () => void
  /** Probes one service through the dev proxy; adds a Test button to each row. */
  test?(id: string): Promise<SystemServiceTest>
}

/**
 * One more section of the System screen, after the built-in ones: a consumer's own operator
 * screen (feature flags, start-up timings). Deep-linkable as `?system=<id>` with `syncUrl`.
 */
export type SystemSection = {
  /** Unique, URL-safe, and not one of the built-in ids (`SYSTEM_SECTION_IDS`). */
  id: string
  label: string
  icon?: SystemIcon
  /** Draws into `host` once, when the System screen first draws; returns the disposer. */
  mount(host: HTMLElement, signal: AbortSignal): (() => void) | Promise<() => void>
}

/** Save, load and reset of the whole in-tab state: the System screen's Data card. */
export type SystemSnapshot = {
  /** The state as a file; the screen downloads it. */
  save(): Promise<Blob>
  /** Replaces the state with a saved file. Rejects with a message the screen shows inline. */
  load(file: File): Promise<void>
  /** Back to the seeded state. */
  reset(): Promise<void>
  /** The downloaded file's name. Default `mockingbird-state-<time>.json`. */
  fileName?(): string
}

/** Where an in-tab backend or emulator is: lazy ones stay `not started` until first called. */
export type SystemBackendState = "not started" | "starting" | "ready" | "failed" | "updating"

/** One in-tab backend or emulator on the System screen. */
export type SystemBackend = {
  id: string
  label?: string
  kind?: "backend" | "emulator"
  state?: SystemBackendState
  /** Why it failed, or what it is doing ("Booting · 40%"). */
  message?: string
}

/**
 * The in-tab backends and emulators. `@crvouga/mockingbird-preview`'s `createBackendHost()` and
 * `backendControls()` are ones; `subscribe` repaints the list when a state changes.
 */
export type SystemBackends = {
  list(): Promise<readonly SystemBackend[]> | readonly SystemBackend[]
  subscribe?(listener: () => void): () => void
}

/** What a surface's `health` probe answers. */
export type SystemHealth = { ok: boolean; message?: string }

/** A message the shell shows over the apps, such as why an update needs a reload. */
export type SystemNotice = {
  tone: "info" | "warning" | "error"
  text: string
  /** One button beside the text (Retry, Reload). */
  action?: { label: string; run(): void }
}

/** A surface as the view shows it: on the System screen's rows and in the switcher's tooltips. */
export type SystemApp = {
  id: string
  label: string
  description?: string | undefined
  icon?: SystemIcon | undefined
  /** The backends and emulators it calls. */
  backends?: readonly string[] | undefined
  /** The version of its code running now (a part pin). */
  version?: string | undefined
  /** A cheap probe the System screen shows on its row. */
  health?: ((signal: AbortSignal) => Promise<SystemHealth> | SystemHealth) | undefined
}

/** What a panel shows over its surface while it mounts, or after its mount failed. */
export type PanelStatus =
  | { id: string; host: HTMLElement; state: "loading" }
  | { id: string; host: HTMLElement; state: "error"; message: string }

/** The harness state the view draws; replaced (never mutated) on every change. */
export type HarnessSnapshot = {
  /** The surface shown. */
  current: string
  /** Every surface id, System included, in the order the switcher's arrows go through them. */
  order: readonly string[]
  /** The ids the arrows skip. */
  excluded: ReadonlySet<string>
  statuses: readonly PanelStatus[]
  /** Where the System screen draws, once its panel has mounted. */
  systemHost?: HTMLElement | undefined
  /** The code version each surface runs now, where `update()` changed it. */
  versions: Readonly<Record<string, string>>
  /** The notice over the apps, if any. */
  notice?: SystemNotice | undefined
}

/** The harness as its React view (`system-view.tsx`) sees it. */
export type HarnessController = {
  shell: HTMLElement
  /** The strip across the top of the shell that the switcher bar draws in. */
  bar: HTMLElement
  /** Every surface, System included, in the order given. */
  apps: readonly SystemApp[]
  /** Whether the switcher bar shows (there is at least one surface besides System). */
  switcher: boolean
  get(): HarnessSnapshot
  subscribe(listener: () => void): () => void
  show(id: string): void
  retry(id: string): void
  setInRotation(id: string, included: boolean): void
  setOrder(ids: readonly string[]): void
  /** Clears the notice over the apps. */
  dismissNotice(): void
  /** Where the switcher's preferences live (its rotation and order). */
  storage(): Pick<Storage, "getItem" | "setItem">
  services?: SystemServices | undefined
  docsUrl?: string | undefined
  build?: SystemBuild | undefined
  /** The in-tab backends and emulators, for the System screen's Backends list. */
  backends?: SystemBackends | undefined
  /** The consumer's own System sections, after the built-in ones. */
  sections?: readonly SystemSection[] | undefined
  /** Save, load and reset, for the System screen's Data card. */
  snapshot?: SystemSnapshot | undefined
  /** The keyboard shortcut that opens System ("Alt+Shift+S"), or false for none. */
  systemShortcut?: string | false | undefined
  /** Whether `?system=<section>` is read and written (the harness's `syncUrl`). */
  syncUrl?: boolean | undefined
}
