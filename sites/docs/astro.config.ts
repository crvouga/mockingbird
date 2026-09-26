import { fileURLToPath } from "node:url"
import node from "@astrojs/node"
import { defineConfig } from "astro/config"
import { catalog } from "./integrations/catalog/index.ts"

const docsRoot = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

// .superset/run.sh sets this so each workspace keeps the port reserved for it.
// Astro's server config has no strictPort; Vite's does, and that is what stops
// the dev server from sliding onto the next workspace's port.
const reservedDocsPort = Number(process.env.MOCKINGBIRD_DOCS_PORT)
const pinDocsPort =
  Number.isInteger(reservedDocsPort) && reservedDocsPort > 0 && reservedDocsPort < 65536

export default defineConfig({
  adapter: node({ mode: "standalone" }),
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [catalog({ repoRoot, docsRoot })],
  ...(pinDocsPort ? { server: { port: reservedDocsPort, host: "127.0.0.1" } } : {}),
  vite: {
    // Each in-browser mock is its own lazily loaded chunk; the largest carry a recorded corpus.
    build: { chunkSizeWarningLimit: 20_000 },
    server: {
      ...(pinDocsPort ? { port: reservedDocsPort, strictPort: true, host: "127.0.0.1" } : {}),
      watch: {
        // Vite ignores node_modules by default, but every `@crvouga/*` workspace
        // package this site imports (service mocks, example apps) is symlinked
        // there and rebuilt independently (`bun run build` in its own package) —
        // without this, `astro dev` keeps serving a stale in-memory copy of a
        // workspace package's `dist/` output until the dev server is restarted.
        ignored: ["!**/node_modules/@crvouga/**"],
      },
    },
  },
})
