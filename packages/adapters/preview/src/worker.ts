/**
 * The generic preview Worker: static assets, the live CI status at `/__preview/*`, and optionally
 * the dev proxy. Stateless; everything it knows comes from its env and the static assets.
 *
 * Portable: Fetch only.
 */
import { createPreviewStatus, type PreviewDeployedVersion } from "./preview-status.js"

/** The static-assets binding, as much of it as the Worker uses. */
export type PreviewAssetsBinding = { fetch(request: Request): Promise<Response> }

/** The Worker's bindings: the static assets plus the vars and secrets the deploy and CI set. */
export type PreviewWorkerEnv = Record<string, unknown> & { ASSETS: PreviewAssetsBinding }

/** A dev proxy (see `./dev-proxy`'s `devProxyWorker`), mounted at its `basePath`. */
export type PreviewWorkerDevProxy = {
  basePath: string
  fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>
}

export type PreviewWorkerOptions = {
  /** Where the live status is served. Default "/__preview". */
  basePath?: string
  /** Optional dev resources proxy, mounted at its `basePath`. It sees only string env values. */
  devProxy?: PreviewWorkerDevProxy
}

export type PreviewWorker = {
  fetch(request: Request, env: PreviewWorkerEnv): Promise<Response>
}

const trimSlash = (path: string): string => {
  let out = path
  while (out.endsWith("/")) out = out.slice(0, -1)
  return out
}

const under = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`)

/**
 * Creates the preview Worker. `/__preview/status` and `/__preview/live` serve the CI status from
 * `PREVIEW_BUILD`, `PREVIEW_CHECKS` and `PREVIEW_PR`, with the deployed version read from the
 * assets' `/version.json`; the dev proxy, when given, serves its `basePath`; every other request
 * is a static asset.
 */
export function createPreviewWorker(options: PreviewWorkerOptions = {}): PreviewWorker {
  const basePath = trimSlash(options.basePath ?? "/__preview")
  const devProxy = options.devProxy
  const devBase = devProxy === undefined ? undefined : trimSlash(devProxy.basePath)
  return {
    fetch(request, env) {
      const { origin, pathname } = new URL(request.url)
      if (under(pathname, basePath)) {
        const status = createPreviewStatus({
          basePath,
          env: () => env,
          readVersion: async () => {
            const response = await env.ASSETS.fetch(new Request(`${origin}/version.json`))
            if (!response.ok) {
              void response.body?.cancel().catch(() => {})
              return undefined
            }
            return (await response.json()) as PreviewDeployedVersion
          },
        })(request)
        if (status) return status
      }
      if (devProxy !== undefined && devBase !== undefined && under(pathname, devBase)) {
        const strings = Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
        return devProxy.fetch(request, strings)
      }
      return env.ASSETS.fetch(request)
    },
  }
}
