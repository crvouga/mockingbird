/**
 * The public types of `@crvouga/mockingbird-notifications/ui`. Framework-free on purpose: the UI is
 * React and HeroUI inside, but an embedder only ever passes plain options and gets plain handles,
 * so its own type checker needs neither React's types nor HeroUI's.
 */
import type { NotificationHarness } from "../harness.js"
import type { Channel, Notification, SourceStatus } from "../model.js"
import type { DeviceLayout } from "./tabs.js"

export type { ChannelTab, DeviceLayout } from "./tabs.js"

export type MotionPreference = "auto" | "full" | "reduce"
export type View = "devices" | "timeline"
export type PushSkin = "auto" | "ios" | "android"
export type Tapback = "heart" | "like" | "dislike" | "laugh" | "emphasize" | "question"

export type AppOptions = {
  /** Read a harness and follow its event stream. Default true. */
  live?: boolean
  /**
   * How to reach the harness: an in-process harness's `fetch`, or any Fetch-compatible function.
   * Default: the global `fetch` against `baseUrl`.
   */
  fetch?: (request: Request) => Promise<Response>
  /** Where the harness API lives. Default: the page's own URL (standalone), or a placeholder origin with `fetch`. */
  baseUrl?: string
  /** Read `?view=…` from the page URL and write `?namespace=` back to it. Default: true only for the standalone page. */
  syncUrl?: boolean
  /** Keep read state in `localStorage`. Default: same as `live`. */
  storage?: boolean
  /** Play alert sounds (and vibrate) on arrivals. Default false; the toolbar toggles it. */
  sound?: boolean
  /** Animations. `auto` follows the viewer's reduced-motion setting. Default `auto`. */
  motion?: MotionPreference
  /** Fill the host element and scroll inside it, for a tab or panel in another app. */
  embedded?: boolean
  /**
   * Draw the shared app shell around the UI (the top bar with the title and the theme switch), as
   * a full page in its own right: the same frame as the admin, the System screen and the example
   * apps. The host scrolls. Overrides `embedded`.
   */
  shell?: boolean
  /** Which devices to show. Default all of them: `sms`, `push`, `email` and `chat`. */
  channels?: Channel[]
  /**
   * How the devices share the space. `auto` (default) lays them side by side and switches to one
   * device at a time, picked with the channel tabs, when the host element is narrower than 800px.
   * `tabs` always shows one device; `grid` never collapses.
   */
  layout?: DeviceLayout
  /** Show the channel tabs (`All | Text | Push | Email | Chat`). Default true; with `false`, `auto` never collapses. */
  tabs?: boolean
  /** Show the toolbar (namespace, filter, view switch, sound, emulator status). Default true. */
  chrome?: boolean
  /**
   * Draw the devices at this fraction of their full size (a phone is 362 by 760px), from 0.5 to 1,
   * for a host with less room than the full-size devices need. Default 1.
   */
  scale?: number
  /** Called with each batch of new notifications. */
  onArrive?: (added: Notification[]) => void
  /**
   * Called with the address of a link clicked in a message (an email, a text, a chat message).
   * Return true when the embedder followed it itself, such as a link back into its own app in
   * the same page; otherwise the link opens in a new tab as usual.
   */
  openLink?: (url: string) => boolean

  /** Fixed notifications to draw when not live. */
  items?: Notification[]
  sources?: SourceStatus[]
  namespaces?: string[]
  namespace?: string
  discoveryError?: string | null
  /** Live-stream indicator when not live. Default true. */
  connected?: boolean
  /** Ids already read (when not live there is no browser storage). */
  seen?: string[]
  /** Ids drawn with their arrival animation. */
  arrived?: string[]
  /** Fixed clock in epoch ms, so relative times and the status bar never move. */
  now?: number
  title?: string
  /** A query string such as `?view=sms&to=…`, as a deep link would carry. */
  search?: string
  initial?: {
    view?: View
    only?: Channel | null
    search?: string
    follow?: boolean
    inspect?: string | null
    mailDetailsOpen?: boolean
    sms?: { to?: string | null; thread?: string | null; menu?: string | null }
    push?: {
      to?: string | null
      skin?: PushSkin
      expanded?: string | null
      preview?: string | null
      settings?: string | null
      openGroups?: string[]
    }
    email?: { to?: string | null; open?: string | null }
    chat?: { to?: string | null }
    toast?: string | null
    /** Narrow screens: the toolbar's extra controls are open. */
    menu?: boolean
    local?: {
      dismissed?: string[]
      pinned?: string[]
      muted?: string[]
      starred?: string[]
      silent?: string[]
      tapbacks?: Record<string, Tapback>
    }
  }
}

export type AppHandle = {
  render(): void
  state: { items: Notification[] }
  /** Resolves once the first read has been drawn (`data-ready="true"` on the root). */
  ready: Promise<void>
  /** Open one notification on its device, or a recipient on a device. */
  show(target: { id?: string; channel?: Channel; to?: string }): void
  setNamespace(namespace: string): void
  setSound(on: boolean): void
  /** Change the `scale` the devices are drawn at. */
  setScale(scale: number): void
  /** Stop streams and timers, remove listeners and empty the host. */
  destroy(): void
}

export type MountOptions = Omit<AppOptions, "fetch"> & {
  /** An in-process harness (anything with a Fetch handler). Omit it to read `baseUrl` over HTTP. */
  harness?: Pick<NotificationHarness, "fetch">
  /** Any Fetch-compatible transport to the harness API. Ignored when `harness` is given. */
  fetch?: NonNullable<AppOptions["fetch"]>
  /**
   * Add the stylesheets (Mockingbird's, and the device skins) to the host's document or shadow
   * root. Default true. Pass false when the page already has them.
   */
  injectStyles?: boolean
}

/** Returns nothing, a dispose function, or a promise of either. */
export type DashboardMount = (panel: HTMLElement) => unknown

export type DashboardTab = {
  /** Unique; also the `?tab=` value. `emulators` and `notifications` are taken. */
  id: string
  label: string
  /** Draw the tab into `panel`, the first time it is shown. May return a dispose function. */
  mount: DashboardMount
}

export type DashboardOptions = {
  /** The product name in the top bar. Default "Notifications". */
  title?: string
  /** The embedder's own tabs, shown first. */
  tabs?: DashboardTab[]
  /** The emulator admin dashboard. `mount` may be async (for example, to load a script first). */
  emulators?: { label?: string; mount: DashboardMount }
  /** The notifications UI: what `mountNotifications` takes, plus a tab label. */
  notifications?: MountOptions & { label?: string }
  /** The tab to open. `?tab=` wins over it when `syncUrl` is set. Default: the first tab. */
  initialTab?: string
  /** Read `?tab=` from the page URL and keep it current. Default false. */
  syncUrl?: boolean
  onTabChange?: (id: string) => void
  /** Light or dark. `auto` (the default) follows the viewer's color scheme. */
  theme?: "dark" | "light" | "auto"
  /** Add the stylesheets to the host's document or shadow root. Default true. */
  injectStyles?: boolean
}

export type DashboardHandle = {
  /** Open a tab by id. Unknown ids are ignored. */
  show(id: string): void
  /** The id of the open tab. */
  active(): string
  /** Tab ids, in bar order. */
  tabs(): string[]
  /** An empty element in the top bar's actions, for a status or a link. */
  aside: HTMLElement
  /** The notifications UI, when the dashboard has one. */
  notifications?: AppHandle
  /** Dispose every mounted tab, remove listeners and empty the host. */
  destroy(): void
}
