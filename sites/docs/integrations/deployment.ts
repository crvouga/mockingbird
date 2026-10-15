import type { AstroIntegration } from "astro"
import { localSourceManifest } from "../src/lib/deployment.ts"

/** Freeze source identity into the image's prerendered health endpoint. */
export function deployment(repoRoot: string): AstroIntegration {
  const id = "virtual:mockingbird/deployment"
  return {
    name: "mockingbird-deployment",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: "mockingbird-deployment-manifest",
                resolveId(name) {
                  return name === id ? `\0${id}` : undefined
                },
                load(name) {
                  return name === `\0${id}`
                    ? `export default ${JSON.stringify(localSourceManifest(repoRoot))}`
                    : undefined
                },
              },
            ],
          },
        })
      },
    },
  }
}
