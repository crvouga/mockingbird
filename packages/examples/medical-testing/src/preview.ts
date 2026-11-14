import { installBrowserRuntime } from "@crvouga/mockingbird-adapter-browser"

installBrowserRuntime()

const host = document.getElementById("system")
if (host) {
  void import("./browser.js")
    .then(({ mount }) => mount(host, { syncUrl: true }))
    .catch((error: unknown) => {
      host.textContent = `Unable to start the system: ${error instanceof Error ? error.message : String(error)}`
    })
}
