import { exampleLoaders } from "virtual:mockingbird/examples"

class ServiceExample extends HTMLElement {
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
    status.textContent = "Loading the example…"
    try {
      const loader = exampleLoaders[this.dataset.example ?? ""]
      if (!loader) throw new Error("This example is not registered")
      const module = await loader()
      if (generation !== this.generation) return
      if (typeof module.mount !== "function") throw new Error("Example must export mount(host)")
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
      status.textContent = `Could not load the example: ${error instanceof Error ? error.message : String(error)}`
      button.disabled = false
      button.textContent = "Try again"
    }
  }
}
if (!customElements.get("service-example")) customElements.define("service-example", ServiceExample)
