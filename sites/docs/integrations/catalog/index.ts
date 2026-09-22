import type { AstroIntegration } from "astro"
import type { Catalog } from "../../src/lib/types.ts"
import { type CatalogPaths, loadCatalog, watchedFiles } from "./load.ts"

const CATALOG_ID = "virtual:mockingbird/catalog"
const RUNTIMES_ID = "virtual:mockingbird/runtimes"

/**
 * Reads the service packages (package.json, README.md and the built module) at build time and
 * exposes them as virtual modules. Nothing the site shows is copied or hand-maintained.
 *
 * - `virtual:mockingbird/catalog`: the whole catalog, for pages (server side only).
 * - `virtual:mockingbird/runtimes`: a lazy `import()` per browser-runnable service, so each
 *   mock becomes its own chunk that loads only when a playground starts it.
 */
export function catalog(paths: CatalogPaths): AstroIntegration {
  let cached: Promise<Catalog> | undefined
  const get = () => {
    cached ??= loadCatalog(paths)
    return cached
  }

  const plugin = {
    name: "mockingbird-catalog",
    resolveId(id: string) {
      return id === CATALOG_ID || id === RUNTIMES_ID ? `\0${id}` : undefined
    },
    async load(id: string) {
      if (id === `\0${CATALOG_ID}`) {
        const data = await get()
        return `export default JSON.parse(${JSON.stringify(JSON.stringify(data))})`
      }
      if (id === `\0${RUNTIMES_ID}`) {
        const data = await get()
        const entries = data.services
          .filter((s) => s.surfaces.browser)
          .map(
            (s) => `  ${JSON.stringify(s.name)}: () => import(${JSON.stringify(s.packageName)}),`,
          )
        return `export const loaders = {\n${entries.join("\n")}\n}\n`
      }
      return undefined
    },
    configureServer(server: {
      watcher: { add(files: string[]): void; on(event: string, cb: (file: string) => void): void }
      moduleGraph: { getModuleById(id: string): unknown; invalidateModule(mod: unknown): void }
      ws: { send(payload: { type: "full-reload" }): void }
    }) {
      const files = new Set(watchedFiles(paths))
      server.watcher.add([...files])
      server.watcher.on("change", (file) => {
        if (!files.has(file)) return
        cached = undefined
        for (const id of [CATALOG_ID, RUNTIMES_ID]) {
          const mod = server.moduleGraph.getModuleById(`\0${id}`)
          if (mod) server.moduleGraph.invalidateModule(mod)
        }
        server.ws.send({ type: "full-reload" })
      })
    },
  }

  return {
    name: "mockingbird-catalog",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [plugin] } })
      },
    },
  }
}
