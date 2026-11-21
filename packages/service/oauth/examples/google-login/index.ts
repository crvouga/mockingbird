import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { Example, type ExampleOptions } from "./harness.js"
import { registerProperties } from "./paste.js"

export type { ExampleOptions }

/**
 * The only DOM-dependent layer: mount the portable application in any browser host. The example
 * lives in a shadow tree of its own, so the host page's styles and the example's stay apart.
 */
export async function mount(host: HTMLElement, options: ExampleOptions = {}) {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  // A shadow tree has no :root; the theme's root tokens apply to the shadow host instead.
  style.textContent = MOCKINGBIRD_CSS.replace(/:root\b/g, ":host")
  registerProperties(document, MOCKINGBIRD_CSS)
  const container = document.createElement("div")
  shadow.replaceChildren(style, container)
  const root = createRoot(container)
  root.render(createElement(Example, { options }))
  return () => {
    root.unmount()
    shadow.replaceChildren()
  }
}
