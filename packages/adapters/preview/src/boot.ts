/**
 * The preview's boot loader: the one script `index.html` loads, and the only code that is never
 * swapped. It reads `version.json`, imports the app version it names (a hashed entry exporting
 * `start(host, { build })`), and keeps watching CI and the deployed version over `/__preview/live`.
 * When a newer version deploys it unmounts the running app and imports the new one into this page,
 * so a tab never needs a reload to be current.
 *
 * Browser: `document`, `location`, `fetch` and dynamic `import()`.
 */
import {
  createLivePreview,
  type LivePreview,
  type LivePreviewOptions,
  type PreviewVersion,
} from "./live.js"

/** What a version's entry module exports. */
export type PreviewApp = {
  start(host: HTMLElement, options: { build?: unknown }): Promise<() => void | Promise<void>>
}

export type BootPreviewOptions = {
  /** The element the app mounts into, or a selector. Default "#preview". */
  host?: HTMLElement | string
  /**
   * Default "./version.json", resolved against `baseUrl`. The live poller reads this same file
   * (unless `live.versionUrl` says otherwise), so boot and updates never disagree about what is
   * deployed.
   */
  versionUrl?: string
  /** Passed through to `createLivePreview` (countdown, storage, …). */
  live?: Partial<Omit<LivePreviewOptions, "current" | "load">>
  /** Imports a version's entry. Default the dynamic `import()`. */
  importEntry?: (url: string) => Promise<unknown>
  /** Default the global `fetch`. */
  fetch?: typeof fetch
  /**
   * The deployment root: where `versionUrl` and each version's entry resolve. The loader that
   * `buildPreview` emits passes its own directory (`new URL("./", import.meta.url)`), so a deep
   * link such as `/settings/profile` still reads `/version.json`. Default `document.baseURI`
   * (the page's address, or its `<base href>`).
   */
  baseUrl?: string
  /** Where the host selector is looked up. Default `document`. */
  document?: Pick<Document, "querySelector">
}

type Version = PreviewVersion & { pr?: { number: number; url: string } }

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Boots the preview: fetches `version.json` (no-store), mounts the version it names and follows
 * every newer deploy. On failure it writes a readable message into the host and rejects.
 */
export async function bootPreview(options: BootPreviewOptions = {}): Promise<LivePreview> {
  const target = options.host ?? "#preview"
  const host =
    typeof target === "string"
      ? ((options.document ?? document).querySelector(target) as HTMLElement | null)
      : target
  if (host === null) throw new Error(`No element matches ${target}`)
  const baseUrl =
    options.baseUrl ??
    (globalThis as { document?: { baseURI?: string } }).document?.baseURI ??
    location.href
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const importEntry = options.importEntry ?? ((url: string) => import(/* @vite-ignore */ url))
  try {
    const versionUrl = new URL(options.versionUrl ?? "./version.json", baseUrl).href
    const response = await doFetch(versionUrl, { cache: "no-store" })
    if (!response.ok) throw new Error(`version.json answered ${response.status}`)
    const current = (await response.json()) as Version
    if (typeof current?.entry !== "string" || typeof current.version !== "string") {
      throw new Error("version.json names no entry")
    }
    const live: LivePreview = createLivePreview({
      ...options.live,
      versionUrl: options.live?.versionUrl ?? versionUrl,
      current,
      ...(current.pr && options.live?.pr === undefined ? { pr: current.pr } : {}),
      load: async (version) => {
        const app = (await importEntry(new URL(version.entry, baseUrl).href)) as PreviewApp
        if (typeof app?.start !== "function") throw new Error(`${version.entry} exports no start`)
        return app.start(host, { build: live })
      },
    })
    await live.start()
    return live
  } catch (error) {
    host.textContent = `Unable to start the preview: ${describe(error)}`
    throw error
  }
}
