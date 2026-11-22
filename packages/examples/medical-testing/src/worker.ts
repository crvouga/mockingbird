import { createPreviewWorker } from "@crvouga/mockingbird-preview/worker"
import { DEV_PROXY_BASE_PATH, devProxy } from "./devProxy.js"

/**
 * The lab preview Worker: the package's preview Worker (static files, and the live CI status at
 * `/__preview/*`, which CI pushes into this Worker's configuration) plus the lab's dev resources
 * proxy at `/__dev/*`. Stateless; same origin as the page.
 */
export default createPreviewWorker({
  devProxy: {
    basePath: DEV_PROXY_BASE_PATH,
    fetch: (request, env) => devProxy.fetch(request, env),
  },
})
