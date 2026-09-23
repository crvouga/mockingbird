import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ClientAssets } from "../app/http/app.js"
import { STYLES } from "../client/theme.js"

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, "..", "client")

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cove — lab testing, made calm</title>
    <style>
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; height: 100%; background: #faf7f0; }
      ${STYLES}
    </style>
  </head>
  <body>
    <div id="app" class="cove-app"></div>
    <script type="module" src="/client.js"></script>
  </body>
</html>
`

/** Bundles the Preact/htm SPA in-process with Bun's bundler — no separate dev server. */
export const buildClientAssets = async (): Promise<ClientAssets> => {
  const result = await Bun.build({
    entrypoints: [join(clientDir, "main.ts")],
    target: "browser",
    format: "esm",
    minify: false,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("client bundle failed")
  }
  const output = result.outputs[0]
  if (!output) throw new Error("client bundle produced no output")
  return { html: HTML, js: await output.text() }
}
