import { sandboxProviders, sandboxProxyWorker } from "@crvouga/mockingbird-preview/sandbox-proxy"

/** The Worker's bindings: the static preview, plus the sandbox secrets set with `wrangler secret`. */
type Env = Record<string, string | undefined> & {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** Must match `SANDBOX_PROXY_PATH` in `composition/sandbox.ts` and `run_worker_first` in wrangler.jsonc. */
const BASE_PATH = "/__sandbox"

const proxy = sandboxProxyWorker({
  basePath: BASE_PATH,
  providers: Object.values(sandboxProviders),
})

/**
 * The lab preview Worker. Static files come from `preview-dist`; `/__sandbox/*` is the sandbox
 * proxy, which attaches the `<SERVICE>_*` secrets to requests the browser's emulators forward
 * to a vendor sandbox. Same origin as the page, so no CORS and no proxy URL to configure.
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
