import {
  devProviders,
  devProxyWorker,
  NON_PROD_PATTERNS,
} from "@crvouga/mockingbird-preview/dev-proxy"
import { createPreviewWorker } from "@crvouga/mockingbird-preview/worker"

/** Must match `DEV_PROXY_PATH` in `composition/dev.ts` and `run_worker_first` in wrangler.jsonc. */
const BASE_PATH = "/__dev"

const proxy = devProxyWorker({
  basePath: BASE_PATH,
  providers: Object.values(devProviders),
  /**
   * The only credentials this proxy will ever use: each value must match its pattern, and a
   * service with no pattern for a value it needs stays emulated. Stripe test keys and Junction
   * sandbox keys prove they are non-production by their format. Resend, Twilio, Slack and FCM
   * keys look the same in production, so pin your dev account's identifier to enable one, e.g.
   *   TWILIO_ACCOUNT_SID: /^AC<your dev account SID>$/,
   *   FCM_PROJECT_ID: /^cove-dev$/,
   */
  allow: { ...NON_PROD_PATTERNS },
})

/**
 * The lab preview Worker: the package's preview Worker (static files, and the live CI status at
 * `/__preview/*`, which CI pushes into this Worker's configuration) plus the lab's dev resources
 * proxy at `/__dev/*`, which attaches allow-listed non-production credentials to requests the
 * browser's emulators forward to a real dev resource. Stateless; same origin as the page.
 */
export default createPreviewWorker({
  devProxy: { basePath: BASE_PATH, fetch: (request, env) => proxy.fetch(request, env) },
})
