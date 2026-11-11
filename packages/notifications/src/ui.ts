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
 * Every rule of the stylesheet is scoped to the UI root (`.mb-notifications`), so it can sit next
 * to the host app's own styles.
 *
 * `mountDashboard` puts that UI and the emulator admin dashboard behind one tab bar:
 *
 *   const dashboard = mountDashboard(host, {
 *     emulators: { mount: (panel) => mountAdmin(panel) },
 *     notifications: { harness },
 *   })
 */
import { ROOT_CLASS, STYLES } from "./ui/styles.js"

export { selectors, TEST_IDS, type TestId } from "./testids.js"
export {
  type AppHandle,
  type AppOptions,
  createApp,
  type MotionPreference,
  type PushSkin,
  type View,
} from "./ui/app.js"
export {
  type DashboardHandle,
  type DashboardOptions,
  type DashboardTab,
  mountDashboard,
} from "./ui/dashboard.js"
export { DASHBOARD_ROOT_CLASS, DASHBOARD_STYLES } from "./ui/dashboard-styles.js"
export { type MountOptions, mountNotifications } from "./ui/mount.js"
export { ROOT_CLASS, STYLES }
