/**
 * The JavaScript half of scripts/bundle-service.ts: one esbuild pass with code splitting, in
 * which the admin page's browser client stays a file of its own.
 *
 * The client (`@crvouga/mockingbird-admin-ui/document`) is ~1.3 MB of React + Ant Design held as
 * one string. The service runtime reaches it only through a dynamic `import()` on the first
 * `/__admin/ui` request (packages/service/core/src/admin-client.ts), so with splitting it never
 * lands in an entry's static import graph: an app that only calls `createRuntime().fetch` never
 * loads or parses it, and an app bundler that splits code keeps it out of its main chunk. A
 * package whose bundle reaches it gets it as `dist/admin-ui.js`, a stable name rather than a
 * hashed chunk, so a single-file app bundle can leave it out by name
 * (`esbuild --external:./admin-ui.js`). It is not an `exports` subpath: only the runtime's own
 * `import("./admin-ui.js")` loads it. A package that declares `@crvouga/mockingbird-admin-ui`
 * itself imports it as it chooses; every other package reaching it through the runtime fails to
 * build if any entry would load it statically.
 */
import { existsSync, realpathSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { type BuildOptions, build, type Metafile } from "esbuild"

/** The dist file name (without `.js`) the admin client is emitted under. */
export const ADMIN_CLIENT_ENTRY = "admin-ui"

const ADMIN_UI_DIST = join(import.meta.dir, "..", "packages", "admin-ui", "dist")
/** `@crvouga/mockingbird-admin-ui/document`, built. Services reach it through the runtime. */
export const ADMIN_CLIENT_MODULE = join(ADMIN_UI_DIST, "document.js")
/** The module that holds the string itself (`ADMIN_BROWSER_BUNDLE`). */
const ADMIN_BUNDLE_MODULE = join(ADMIN_UI_DIST, "bundle.js")

/** A file's key in an esbuild metafile built from `absWorkingDir`. */
const metafileKey = (absWorkingDir: string, path: string): string =>
  relative(absWorkingDir, realpathSync(path)).replaceAll("\\", "/")

/**
 * Output files (metafile keys) that hold the admin client's bundle but are not the admin
 * client's own file. Any of them means an entry would load the bundle eagerly.
 */
export function adminClientLeaks(
  metafile: Metafile,
  absWorkingDir: string,
  outdir: string,
): string[] {
  if (!existsSync(ADMIN_BUNDLE_MODULE)) return []
  const input = metafileKey(absWorkingDir, ADMIN_BUNDLE_MODULE)
  const own = relative(absWorkingDir, join(absWorkingDir, outdir, `${ADMIN_CLIENT_ENTRY}.js`))
  return Object.entries(metafile.outputs)
    .filter(([file, output]) => file !== own.replaceAll("\\", "/") && input in output.inputs)
    .map(([file]) => file)
}

export type ServiceJsOptions = Pick<
  BuildOptions,
  "define" | "external" | "platform" | "plugins"
> & {
  absWorkingDir: string
  /** Relative to `absWorkingDir`; emptied first. */
  outdir: string
  /** Output name (no extension) → source path. */
  entryPoints: Record<string, string>
  /**
   * The package imports `@crvouga/mockingbird-admin-ui` itself, because it always serves the page
   * (the notifications harness): its imports stay as written and are not checked.
   */
  importsAdminUi?: boolean
}

export async function bundleServiceJs(options: ServiceJsOptions): Promise<Metafile> {
  const { absWorkingDir, outdir, entryPoints } = options
  if (ADMIN_CLIENT_ENTRY in entryPoints)
    throw new Error(`the entry name "${ADMIN_CLIENT_ENTRY}" is reserved for the admin client`)
  const once = async (extra: Record<string, string>) => {
    rmSync(join(absWorkingDir, outdir), { recursive: true, force: true })
    const result = await build({
      absWorkingDir,
      entryPoints: { ...entryPoints, ...extra },
      outdir,
      bundle: true,
      // Always on, even for one entry: without it esbuild inlines dynamically imported modules.
      splitting: true,
      format: "esm",
      mainFields: ["module", "main"],
      target: "es2022",
      sourcemap: true,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.define !== undefined ? { define: options.define } : {}),
      ...(options.external !== undefined ? { external: options.external } : {}),
      ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
      logLevel: "warning",
      metafile: true,
    })
    if (!result.metafile) throw new Error("esbuild returned no metafile")
    return result.metafile
  }
  let metafile = await once({})
  if (options.importsAdminUi) return metafile
  // Splitting already gave the client a chunk of its own; build again to give it its stable name.
  if (
    existsSync(ADMIN_CLIENT_MODULE) &&
    metafileKey(absWorkingDir, ADMIN_CLIENT_MODULE) in metafile.inputs
  )
    metafile = await once({ [ADMIN_CLIENT_ENTRY]: ADMIN_CLIENT_MODULE })
  const leaks = adminClientLeaks(metafile, absWorkingDir, outdir)
  if (leaks.length > 0)
    throw new Error(
      `the admin UI bundle is imported statically (it is in ${leaks.join(", ")}); load it only through the runtime's dynamic import of @crvouga/mockingbird-admin-ui/document`,
    )
  return metafile
}
