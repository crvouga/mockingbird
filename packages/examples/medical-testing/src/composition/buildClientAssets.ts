import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderDocument } from "@crvouga/mockingbird-ui/document"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import type { ClientAssets } from "../app/http/app.js"

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, "..", "client")

/**
 * The standalone server's one page: the shared document (head, favicon, the visitor's theme
 * choice) with the design system's stylesheet inlined, an empty `#app`, and the client bundle.
 */
const HTML = renderDocument({
  title: "Lab ordering workspace",
  css: MOCKINGBIRD_CSS,
  rootId: "app",
  rememberTheme: true,
  head: '<script type="module" src="/client.js"></script>',
})

/** Bundles the React client in-process with Bun's bundler — no separate dev server. */
export const buildClientAssets = async (): Promise<ClientAssets> => {
  const result = await Bun.build({
    entrypoints: [join(clientDir, "main.tsx")],
    target: "browser",
    format: "esm",
    minify: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("client bundle failed")
  }
  const output = result.outputs[0]
  if (!output) throw new Error("client bundle produced no output")
  return { html: HTML, js: await output.text() }
}
