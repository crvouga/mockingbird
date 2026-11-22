import {
  devProviders,
  devProxyWorker,
  NON_PROD_PATTERNS,
} from "@crvouga/mockingbird-preview/dev-proxy"

/** Must match `DEV_PROXY_PATH` in `composition/dev.ts` and `run_worker_first` in wrangler.jsonc. */
export const DEV_PROXY_BASE_PATH = "/__dev"

/**
 * The lab's dev resources proxy: it attaches allow-listed non-production credentials to requests
 * the browser's emulators forward to a real dev resource. The deployed preview Worker
 * (`worker.ts`) and the local dev server (`scripts/dev-preview.ts`) both mount it.
 */
export const devProxy = devProxyWorker({
  basePath: DEV_PROXY_BASE_PATH,
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
