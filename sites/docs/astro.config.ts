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
  },
})
