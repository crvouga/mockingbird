/**
 * Services build on the published `@crvouga/mockingbird-runtime` instead of inlining it (#699,
 * #766): with that package in a service's `dependencies`, scripts/bundle-service.ts resolves
 * every import of a workspace helper the runtime ships (`@crvouga/mockingbird-<helper>[/sub]`)
 * to the runtime's subpath (`@crvouga/mockingbird-runtime/<helper>[/sub]`) and leaves it an
 * import. Every service then shares one copy of the router, admin, snapshots, faults, clock and
 * the admin page's 1.3 MB browser client, and one copy of their module state.
 *
 * What stays per service is what the bundle used to bake into the runtime with `define`: its
 * package version and its admin vendor chip. `@crvouga/mockingbird-service` resolves to a small
 * module of the service's own that re-exports the runtime's and gives `createRuntime` those
 * defaults; `version` and `adminBrand` passed by the caller still win.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Metafile, Plugin } from "esbuild"

export const RUNTIME_PACKAGE = "@crvouga/mockingbird-runtime"
export const RUNTIME_DIR = join(import.meta.dir, "..", "packages", "runtime")
const HELPER_PREFIX = "@crvouga/mockingbird-"
/** The helper whose `createRuntime` gets the service's own version and brand. */
const SERVICE_RUNTIME = "@crvouga/mockingbird-service"

/** The runtime's subpaths (`core`, `service/admin`, …), read from its `exports`. */
export function runtimeSubpaths(dir = RUNTIME_DIR): Set<string> {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports: Record<string, unknown>
  }
  return new Set(
    Object.keys(manifest.exports)
      .filter((key) => key !== ".")
      .map((key) => key.replace(/^\.\//, "")),
  )
}

/** The runtime specifier a helper import becomes, or undefined when the runtime does not ship it. */
export function runtimeSpecifier(id: string, subpaths: Set<string>): string | undefined {
  if (!id.startsWith(HELPER_PREFIX)) return undefined
  const subpath = id.slice(HELPER_PREFIX.length)
  return subpaths.has(subpath) ? `${RUNTIME_PACKAGE}/${subpath}` : undefined
}

/**
 * The service's own `@crvouga/mockingbird-service`: the runtime's, with `createRuntime` and
 * `PACKAGE_VERSION` carrying this build's `define`s (scripts/bundle-service.ts).
 */
export const serviceRuntimeShim = (
  target: string,
): string => `export * from ${JSON.stringify(target)}
import { PACKAGE_VERSION as SHARED_VERSION, createRuntime as sharedRuntime } from ${JSON.stringify(target)}
export const PACKAGE_VERSION =
  typeof __MOCKINGBIRD_PACKAGE_VERSION__ === "string" ? __MOCKINGBIRD_PACKAGE_VERSION__ : SHARED_VERSION
const ADMIN_BRAND =
  typeof __MOCKINGBIRD_ADMIN_BRAND__ === "object" ? __MOCKINGBIRD_ADMIN_BRAND__ : undefined
export const createRuntime = (options) =>
  sharedRuntime({
    ...options,
    version: options.version ?? PACKAGE_VERSION,
    adminBrand: options.adminBrand ?? ADMIN_BRAND,
  })
`

const SHIM_NAMESPACE = "mockingbird-service-runtime"

/** Resolve helper imports to the runtime package, as external imports. */
export function sharedRuntimePlugin(subpaths: Set<string> = runtimeSubpaths()): Plugin {
  return {
    name: "mockingbird-shared-runtime",
    setup(build) {
      build.onResolve({ filter: /^@crvouga\/mockingbird-/ }, (args) => {
        const target = runtimeSpecifier(args.path, subpaths)
        if (target === undefined) return undefined
        if (args.path === SERVICE_RUNTIME && args.namespace !== SHIM_NAMESPACE)
          return { path: target, namespace: SHIM_NAMESPACE }
        return { path: target, external: true }
      })
      build.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, (args) => ({
        contents: serviceRuntimeShim(args.path),
        loader: "js",
        resolveDir: process.cwd(),
      }))
    },
  }
}

/** The admin page's client package; the runtime carries it, so a service must not. */
const ADMIN_UI_PACKAGE = "@crvouga/mockingbird-admin-ui"

/** The name in the nearest package.json at or above `file` that has one. */
const ownerCache = new Map<string, string | undefined>()
function ownerName(file: string): string | undefined {
  const dir = dirname(file)
  if (ownerCache.has(dir)) return ownerCache.get(dir)
  const manifest = join(dir, "package.json")
  const name = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name
    : undefined
  const owner = name ?? (dirname(dir) === dir ? undefined : ownerName(dir))
  ownerCache.set(dir, owner)
  return owner
}

/**
 * Inputs of a build that belong to code the runtime ships (a helper it re-exports, or the admin
 * page's client), as `<package>: <input>`. Any of them means the service inlined its own copy.
 */
export function sharedRuntimeLeaks(
  metafile: Metafile,
  absWorkingDir: string,
  subpaths: Set<string> = runtimeSubpaths(),
): string[] {
  const leaks: string[] = []
  for (const input of Object.keys(metafile.inputs)) {
    if (input.includes(":")) continue
    const owner = ownerName(resolve(absWorkingDir, input))
    if (owner === undefined) continue
    if (owner === ADMIN_UI_PACKAGE || runtimeSpecifier(owner, subpaths) !== undefined)
      leaks.push(`${owner}: ${input}`)
  }
  return leaks
}
