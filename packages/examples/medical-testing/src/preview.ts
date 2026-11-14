import { mount } from "./browser.js"

const host = document.getElementById("system")
if (host) {
  void mount(host, { syncUrl: true }).catch((error: unknown) => {
    host.textContent = `Unable to start the system: ${error instanceof Error ? error.message : String(error)}`
  })
}
