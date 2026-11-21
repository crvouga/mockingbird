import {
  devProviders,
  devProxyWorker,
  NON_PROD_PATTERNS,
} from "@crvouga/mockingbird-preview/dev-proxy"
import {
  createPreviewStatusObject,
  githubOidcVerifier,
  previewStatusRoutes,
} from "@crvouga/mockingbird-preview/preview-status"

/** The Worker's bindings: the static preview, its live status object, and the credentials set
 * with `wrangler secret`. */
type Env = Record<string, unknown> & {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** The repository whose CI may post this preview's build and checks events. */
const REPOSITORY = "crvouga-organization/mockingbird"

/**
 * The preview's live status: CI posts build and checks events to `/__preview/events`, signed with
 * the run's GitHub OIDC token (no shared secret), and every open tab hears them over
 * `/__preview/live` (`wrangler.jsonc` binds it as PREVIEW_STATUS).
 */
export const PreviewStatus = createPreviewStatusObject({
  verify: githubOidcVerifier({ repository: REPOSITORY }),
})
const previewStatus = previewStatusRoutes()

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
 * forward to a real dev resource; `/__preview/*` is the live CI status. Same origin as the page,
 * so no CORS and no URL to configure.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const status = previewStatus(request, env)
    if (status) return status
    const { pathname } = new URL(request.url)
    if (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) {
      const secrets = Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
      return proxy.fetch(request, secrets)
    }
    return env.ASSETS.fetch(request)
  },
}
