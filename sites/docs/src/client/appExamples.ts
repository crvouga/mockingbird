/**
 * Loaders for full-stack app examples (`../lib/appExamples.ts`). Small and
 * hand-maintained on purpose — unlike `virtual:mockingbird/examples`, which
 * the catalog integration derives from every service's own package.json,
 * there is exactly one of these per app, not per service.
 */
const appLoaders: Record<
  string,
  () => Promise<{ mount: (host: HTMLElement) => Promise<() => void> }>
> = {
  "medical-testing": () => import("@crvouga/mockingbird-example-medical-testing/browser"),
}

class AppExample extends HTMLElement {
  private cleanup: (() => void) | undefined
  private generation = 0
  private readonly start = () => {
    void this.launch()
  }
  connectedCallback() {
    this.querySelector("[data-example-start]")?.addEventListener("click", this.start)
  }
  disconnectedCallback() {
    this.generation++
    this.cleanup?.()
    this.cleanup = undefined
    this.querySelector("[data-example-start]")?.removeEventListener("click", this.start)
    const button = this.querySelector<HTMLButtonElement>("[data-example-start]")
    const placeholder = this.querySelector<HTMLElement>("[data-example-placeholder]")
    if (button) button.disabled = false
    if (placeholder) placeholder.hidden = false
  }
  private async launch() {
    const button = this.querySelector<HTMLButtonElement>("[data-example-start]")
    const status = this.querySelector<HTMLElement>("[data-example-status]")
    const host = this.querySelector<HTMLElement>("[data-example-host]")
    const placeholder = this.querySelector<HTMLElement>("[data-example-placeholder]")
    if (!button || !host || !status || !placeholder) return
    const generation = ++this.generation
    button.disabled = true
    status.textContent = "Loading the app…"
    try {
      const loader = appLoaders[this.dataset.app ?? ""]
      if (!loader) throw new Error("This app is not registered")
      const module = await loader()
      if (generation !== this.generation) return
      const cleanup = await module.mount(host)
      if (generation !== this.generation) {
        cleanup?.()
        return
      }
      this.cleanup = cleanup ?? undefined
      placeholder.hidden = true
      const focusRoot = host.shadowRoot ?? host
      focusRoot.querySelector<HTMLElement>("button, select, a, input, [tabindex='0']")?.focus()
    } catch (error) {
      if (generation !== this.generation) return
      host.replaceChildren()
      status.textContent = `Could not load the app: ${error instanceof Error ? error.message : String(error)}`
      button.disabled = false
      button.textContent = "Try again"
    }
  }
}
if (!customElements.get("app-example")) customElements.define("app-example", AppExample)
