import { cpSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AstroIntegration } from "astro"

/**
 * Publishes the UI catalog (sites/storybook, built first by turbo as a dependency of this site)
 * at `/storybook/`: copied into the client output after `astro build`, next to the pages its
 * "Docs site" stories frame. `server/headers.ts` gives the path its own CSP.
 */
export function storybook(repoRoot: string): AstroIntegration {
  const built = join(repoRoot, "sites/storybook/storybook-static")
  return {
    name: "mockingbird-storybook",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        if (!existsSync(join(built, "index.html"))) {
          logger.warn(
            `${built} is not built; /storybook/ is left out (turbo run build builds it first)`,
          )
          return
        }
        const client = fileURLToPath(dir).replace(/[\\/]server[\\/]?$/, "")
        const target = join(
          client.endsWith("client") ? client : join(client, "..", "client"),
          "storybook",
        )
        cpSync(built, target, { recursive: true })
        logger.info(`UI catalog published at /storybook/ (${target})`)
      },
    },
  }
}
