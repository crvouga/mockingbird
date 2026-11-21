import { createLivePreview, type PreviewVersion } from "@crvouga/mockingbird-preview"

/**
 * The preview's boot loader: the one script `index.html` loads, and the only code that is never
 * swapped. It reads `version.json`, imports the app version it names (`app.ts`, built to a hashed
 * file), and keeps watching CI and the deployed version over `/__preview/live`. When a newer
 * version deploys, it unmounts the running app and imports the new one into this page, so a tab
 * never needs a reload to be current.
 */
type App = { start(host: HTMLElement, options: { build?: unknown }): Promise<() => void> }
type Version = PreviewVersion & { pr?: { number: number; url: string } }

const host = document.getElementById("system")
if (host) {
  try {
    const response = await fetch("./version.json", { cache: "no-store" })
    if (!response.ok) throw new Error(`version.json answered ${response.status}`)
    const current = (await response.json()) as Version
    const live = createLivePreview({
      current,
      ...(current.pr ? { pr: current.pr } : {}),
      load: async (version) => {
        const app = (await import(new URL(version.entry, location.href).href)) as App
        return app.start(host, { build: live })
      },
    })
    await live.start()
  } catch (error) {
    host.textContent = `Unable to start the system: ${error instanceof Error ? error.message : String(error)}`
  }
}
