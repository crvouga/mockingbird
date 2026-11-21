import { installBrowserRuntime } from "@crvouga/mockingbird-adapter-browser"
import type { SystemBuild } from "@crvouga/mockingbird-ui"

/**
 * One version of the preview app, built to a hashed file (`app-<hash>.js`) that `version.json`
 * names. The boot loader (`preview.ts`) imports it, and imports the next version's file into the
 * same page when one deploys. `start` installs the browser runtime before any app module runs and
 * returns a disposer that unmounts the app and removes the runtime again, so the next version can
 * install its own.
 */
export const start = async (
  host: HTMLElement,
  options: { build?: SystemBuild } = {},
): Promise<() => void> => {
  const uninstall = installBrowserRuntime()
  try {
    const { mount } = await import("./composition/browser.js")
    const unmount = await mount(host, {
      syncUrl: true,
      devProxyUrl: "/__dev",
      ...(options.build ? { build: options.build } : {}),
    })
    return () => {
      unmount()
      uninstall()
    }
  } catch (error) {
    uninstall()
    throw error
  }
}
