/// <reference lib="dom" />
/**
 * The harness UI as a component, for an app that wants its notifications on a tab or panel of its
 * own page: in the browser, against an in-process harness, with no server and no network.
 *
 *   const harness = createNotificationHarness({ services: { twilio, resend, fcm } })
 *   const ui = mountNotifications(panel, { harness })
 *   await ui.ready
 *   ui.destroy()
 *
 * The UI is React and HeroUI, the shared Mockingbird design system, prebuilt into this package
 * (`#ui/embed`, `dist-ui/embed.js`): the embedder needs neither. Mockingbird's stylesheet and the
 * device skins are added once to the host's document, or to the shadow root that holds the host.
 *
 * `mountDashboard` puts that UI and the emulator admin dashboard behind one set of tabs:
 *
 *   const dashboard = mountDashboard(host, {
 *     emulators: { mount: (panel) => mountAdmin(panel) },
 *     notifications: { harness },
 *   })
 */
import * as embed from "#ui/embed"
import type {
  AppHandle,
  AppOptions,
  DashboardHandle,
  DashboardOptions,
  MountOptions,
} from "./ui/types.js"

export { selectors, TEST_IDS, type TestId } from "./testids.js"
export type {
  AppHandle,
  AppOptions,
  ChannelTab,
  DashboardHandle,
  DashboardOptions,
  DashboardTab,
  DeviceLayout,
  MotionPreference,
  MountOptions,
  PushSkin,
  View,
} from "./ui/types.js"

/** Mount the live harness UI inside `host`; it fills the element and scrolls inside it. */
export const mountNotifications: (host: HTMLElement, options?: MountOptions) => AppHandle =
  embed.mountNotifications

/** A tab bar (Emulators, Notifications, your own tabs) in the Mockingbird shell, inside `host`. */
export const mountDashboard: (host: HTMLElement, options: DashboardOptions) => DashboardHandle =
  embed.mountDashboard

/** The UI without the style injection and embedded defaults of `mountNotifications`. */
export const createApp: (host: HTMLElement, options?: AppOptions) => AppHandle = embed.createApp

/** The device skins' stylesheet (pair it with `MOCKINGBIRD_CSS` from `@crvouga/mockingbird-ui/styles`). */
export const STYLES: string = embed.STYLES
/** The class on the UI root, which every rule in `STYLES` is scoped to. */
export const ROOT_CLASS: string = embed.ROOT_CLASS
/** What the dashboard adds to Mockingbird's stylesheet: the device skins. */
export const DASHBOARD_STYLES: string = embed.DASHBOARD_STYLES
/** The class on the dashboard's host element. */
export const DASHBOARD_ROOT_CLASS: string = embed.DASHBOARD_ROOT_CLASS
