import {
  devProviders,
  devProxyWorker,
  NON_PROD_PATTERNS,
} from "@crvouga/mockingbird-preview/dev-proxy"
import { createPreviewStatus } from "@crvouga/mockingbird-preview/preview-status"

/** The Worker's bindings: the static preview, plus vars and secrets set by the deploy. */
type Env = Record<string, unknown> & {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** The Workers edge cache, when this runs on Cloudflare; the status function also caches in memory. */
const edgeCache = (
  globalThis as { caches?: { default?: Parameters<typeof createPreviewStatus>[0]["cache"] } }
).caches?.default

/**
 * The preview's live status, stateless: on request it reads CI for this PR from the GitHub API
 * (the System preview build and the CI checks for the PR's head commit) and the deployed version
 * from `version.json`, caches the answer for a few seconds, and serves it at `/__preview/status`
 * and as Server-Sent Events at `/__preview/live`. The deploy sets PREVIEW_REPOSITORY and
 * PREVIEW_PR; the optional PREVIEW_GITHUB_TOKEN (read-only) raises GitHub's rate limit.
 */
let previewStatus: ReturnType<typeof createPreviewStatus> | undefined
const previewStatusFor = (env: Env, origin: string) => {
  const pr = Number(env.PREVIEW_PR)
  if (typeof env.PREVIEW_REPOSITORY !== "string" || !(pr > 0)) return undefined
  previewStatus ??= createPreviewStatus({
    repository: env.PREVIEW_REPOSITORY,
    pr,
    ...(typeof env.PREVIEW_GITHUB_TOKEN === "string" && env.PREVIEW_GITHUB_TOKEN
      ? { token: env.PREVIEW_GITHUB_TOKEN }
      : {}),
    ...(edgeCache ? { cache: edgeCache } : {}),
    readVersion: async () => {
      const response = await env.ASSETS.fetch(new Request(`${origin}/version.json`))
      return response.ok
        ? ((await response.json()) as { version: string; builtAt: string })
        : undefined
    },
  })
  return previewStatus
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
 * forward to a real dev resource; `/__preview/*` is the live CI status. Both are stateless
 * functions with no storage of their own. Same origin as the page,
 * so no CORS and no URL to configure.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { origin, pathname } = new URL(request.url)
    const status = previewStatusFor(env, origin)?.(request)
    if (status) return status
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
