/**
 * Every live example on the site (per-service `mockingbird.examples` and the
 * full-stack app examples) opens in the same modal surface: a native modal
 * `<dialog>` in the top layer, with the example mounted inside a window that
 * is its own containing block (`contain: layout paint` on
 * `.example-modal-body` in global.css).
 *
 * That containment is what makes modal stacking work without any coordination
 * with the example: an example's own `position: fixed` overlays (Cove's OAuth
 * and checkout modals, the OAuth example's provider window) resolve against
 * that window instead of the viewport, so they stack inside the example window
 * and never escape over the docs chrome, whatever z-index they pick. An
 * example that does reach for the top layer (`showModal()`) still stacks
 * above this dialog natively, and Escape closes the topmost one first.
 *
 * Examples that handle Escape themselves call `preventDefault()` on the
 * keydown, which the platform treats as "this close request is taken" — the
 * docs dialog stays open and only the example's own modal closes.
 */

type ExampleModule = { mount?: unknown }
type Mount = (host: HTMLElement) => Promise<(() => void) | undefined>

export function defineExampleLauncher(
  tag: string,
  resolve: (key: string) => (() => Promise<ExampleModule>) | undefined,
) {
  class ExampleLauncher extends HTMLElement {
    private cleanup: (() => void) | undefined
    private generation = 0
    private opener: HTMLElement | null = null

    private get dialog() {
      return this.querySelector<HTMLDialogElement>("dialog[data-example-modal]")
    }

    private readonly open = () => {
      const dialog = this.dialog
      if (!dialog || dialog.open) return
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      document.documentElement.classList.add("example-modal-open")
      void this.launch()
    }

    private readonly close = () => {
      this.dialog?.close()
    }

    /** Runs however the dialog closed: button, Escape, or `close()` from elsewhere. */
    private readonly closed = () => {
      this.unmount()
      if (!document.querySelector("dialog[data-example-modal][open]"))
        document.documentElement.classList.remove("example-modal-open")
      this.opener?.focus()
      this.opener = null
    }

    connectedCallback() {
      for (const button of this.querySelectorAll("[data-example-open]"))
        button.addEventListener("click", this.open)
      for (const button of this.querySelectorAll("[data-example-close]"))
        button.addEventListener("click", this.close)
      this.dialog?.addEventListener("close", this.closed)
    }

    disconnectedCallback() {
      for (const button of this.querySelectorAll("[data-example-open]"))
        button.removeEventListener("click", this.open)
      for (const button of this.querySelectorAll("[data-example-close]"))
        button.removeEventListener("click", this.close)
      this.dialog?.removeEventListener("close", this.closed)
      if (this.dialog?.open) this.dialog.close()
      this.unmount()
    }

    private unmount() {
      this.generation++
      this.cleanup?.()
      this.cleanup = undefined
      // A fresh host per launch: an example may have attached a shadow root,
      // which cannot be removed from an element once created.
      const host = this.querySelector<HTMLElement>("[data-example-host]")
      if (host) host.replaceWith(host.cloneNode(false))
    }

    private async launch() {
      const host = this.querySelector<HTMLElement>("[data-example-host]")
      const status = this.querySelector<HTMLElement>("[data-example-status]")
      if (!host || !status) return
      const generation = ++this.generation
      status.hidden = false
      status.textContent = "Loading the example…"
      try {
        const loader = resolve(this.dataset.example ?? "")
        if (!loader) throw new Error("This example is not registered")
        const module = await loader()
        if (generation !== this.generation) return
        if (typeof module.mount !== "function") throw new Error("Example must export mount(host)")
        const cleanup = await (module.mount as Mount)(host)
        if (generation !== this.generation) {
          cleanup?.()
          return
        }
        this.cleanup = cleanup ?? undefined
        status.hidden = true
        const focusRoot = host.shadowRoot ?? host
        focusRoot.querySelector<HTMLElement>("button, select, a, input, [tabindex='0']")?.focus()
      } catch (error) {
        if (generation !== this.generation) return
        status.textContent = `Could not load the example: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  if (!customElements.get(tag)) customElements.define(tag, ExampleLauncher)
}
