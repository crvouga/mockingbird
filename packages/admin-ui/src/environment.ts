import { createContext, useContext } from "react"
import type { AdminApiConfig, AdminFetch, Api, Panel } from "./model.js"

/** A custom panel's behaviour as real code: called once with the panel body, may return a cleanup. */
export type PanelScript = (root: HTMLElement, api: Api) => unknown

/**
 * What an embedder supplies in place of the page globals. Every field is optional; the
 * defaults are the document the UI is mounted in, which is what an emulator's own
 * `/__admin/ui` page wants.
 */
export type AdminEnvironment = {
  /** Sends every admin API and brand catalog request. Defaults to the page's `fetch`. */
  fetch?: AdminFetch
  /**
   * The URL the UI reads its `?emulator=`, `?namespace=`, `?admin_key=`, `?brands=` and `#view`
   * from. Give one to keep the UI off the host page's address: its view changes are then kept
   * in memory (and passed to `history`, if given) instead of rewriting the real URL.
   */
  location?: { readonly href: string }
  /** Receives the UI's URL updates. Defaults to the page's `history`, or nothing with `location`. */
  history?: { replaceState(data: unknown, unused: string, url: string): void }
  /** Where the Command/Ctrl + K shortcut is listened for. Defaults to `document`. */
  shortcutTarget?: EventTarget
  /** The box the UI fills. Defaults to the window, or the shadow host inside a shadow root. */
  viewport?: Element
  /** Where Ant Design's `<style>` elements go. Defaults to `document.head` or the shadow root. */
  styleContainer?: Element | ShadowRoot
  /**
   * How a custom panel's `script` runs. The prebuilt document compiles its source string with
   * `new Function`, which a Content Security Policy without `'unsafe-eval'` refuses. The
   * `./browser` module never compiles a string: return a real function here to run a panel
   * from bundled code. `undefined` (or `false` for every panel) leaves a panel inactive: it
   * still shows its markup, with a notice pointing at the emulator's own admin page.
   */
  panelScript?: false | ((panel: Panel, api: AdminApiConfig) => PanelScript | undefined)
}

export type AdminRuntime = {
  fetch: AdminFetch
  href(): string
  replaceUrl(url: string): void
  shortcutTarget(): EventTarget
  viewport: Element | undefined
  panelScript(panel: Panel, api: AdminApiConfig): PanelScript | undefined
}

/** `scripts/build.ts` sets this to false in the ES module build, which drops the compiler. */
declare const __MOCKINGBIRD_ADMIN_COMPILES_PANELS__: boolean | undefined

const compilePanelScript: AdminRuntime["panelScript"] =
  typeof __MOCKINGBIRD_ADMIN_COMPILES_PANELS__ !== "undefined" &&
  !__MOCKINGBIRD_ADMIN_COMPILES_PANELS__
    ? () => undefined
    : (panel) =>
        panel.script ? (new Function("root", "api", panel.script) as PanelScript) : undefined

export const resolveEnvironment = (env: AdminEnvironment = {}): AdminRuntime => {
  // Read the page globals when they are used, never when this module loads: it is also
  // imported where there is no DOM.
  let href = env.location?.href
  const panelScript = env.panelScript
  return {
    fetch: env.fetch ?? ((input, init) => fetch(input, init)),
    href: () => href ?? location.href,
    replaceUrl: (url) => {
      if (href === undefined) (env.history ?? history).replaceState(null, "", url)
      else {
        href = url
        env.history?.replaceState(null, "", url)
      }
    },
    shortcutTarget: () => env.shortcutTarget ?? document,
    viewport: env.viewport,
    panelScript:
      panelScript === undefined
        ? compilePanelScript
        : panelScript === false
          ? () => undefined
          : panelScript,
  }
}

const RuntimeContext = createContext<AdminRuntime | null>(null)
export const RuntimeProvider = RuntimeContext.Provider

export const useRuntime = (): AdminRuntime => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("The admin UI is not mounted")
  return runtime
}
