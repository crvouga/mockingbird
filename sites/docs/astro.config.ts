import { fileURLToPath } from "node:url"
import { defineConfig } from "astro/config"
import { catalog } from "./integrations/catalog/index.ts"

const docsRoot = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig({
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [catalog({ repoRoot, docsRoot })],
  vite: {
    // Each in-browser mock is its own lazily loaded chunk; the largest carry a recorded corpus.
    build: { chunkSizeWarningLimit: 20_000 },
    server: {
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
