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

/** A surface as the view shows it: on the System screen's rows and in the switcher's tooltips. */
export type SystemApp = {
  id: string
  label: string
  description?: string | undefined
  icon?: SystemIcon | undefined
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
}

/** The harness as its React view (`system-view.tsx`) sees it. */
export type HarnessController = {
  shell: HTMLElement
  /** Every surface, System included, in the order given. */
  apps: readonly SystemApp[]
  /** Whether the switcher pill shows (there is at least one surface besides System). */
  switcher: boolean
  get(): HarnessSnapshot
  subscribe(listener: () => void): () => void
  show(id: string): void
  retry(id: string): void
  setInRotation(id: string, included: boolean): void
  setOrder(ids: readonly string[]): void
  services?: SystemServices | undefined
  docsUrl?: string | undefined
  build?: SystemBuild | undefined
}
