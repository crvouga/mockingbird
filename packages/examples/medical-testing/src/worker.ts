import {
  devProviders,
  devProxyWorker,
  NON_PROD_PATTERNS,
} from "@crvouga/mockingbird-preview/dev-proxy"

/** The Worker's bindings: the static preview, plus the credentials set with `wrangler secret`. */
type Env = Record<string, string | undefined> & {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

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
 * The lab preview Worker. Static files come from `preview-dist`; `/__dev/*` is the dev proxy,
 * which attaches allow-listed non-production credentials to requests the browser's emulators
 * forward to a real dev resource. Same origin as the page, so no CORS and no URL to configure.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) {
      const { ASSETS: _assets, ...secrets } = env
      return proxy.fetch(request, secrets)
    }
    return env.ASSETS.fetch(request)
  },
}
