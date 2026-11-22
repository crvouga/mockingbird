/**
 * Builds a static live preview: the app as one hashed entry per version, the stable boot loader
 * (`preview.js`, see `./boot`), `index.html`, `build.json` and a development `version.json`. A
 * deploy then stamps `version.json` with the commit it ships (`stampPreviewVersion`). While you
 * work, `devPreview` (`./dev-preview`) serves the same preview from memory and rebuilds on save.
 *
 * Bun / Node only (esbuild and the file system). esbuild is a peer dependency.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { type BuildOptions, build, type Metafile } from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))
const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js"

export type BuildPreviewOptions = {
  /** The app module: it exports `start(host, { build })`, which mounts the app and returns its disposer. */
  entry: string
  /** Output directory; emptied first. */
  outdir: string
  /** The page's `<title>`. Default "Preview". */
  title?: string
  /** The id of the element the app mounts into. Default "preview". */
  hostId?: string
  /**
   * The path the preview is served under, with leading and trailing slashes. Default "/".
   * `index.html` loads `<base>preview.js` by absolute path, so the single-page-application fallback
   * can serve it at any deep link (`/settings/profile`) and still boot.
   */
  base?: string
  /**
   * Extra esbuild options merged into the app build (plugins, inject, define, platform, target,
   * …), e.g. `browserRuntimeBuildOptions()` from `@crvouga/mockingbird-adapter-browser/build`.
   * The entry, output, format, splitting, naming and metafile stay as `buildPreview` sets them.
   */
  esbuild?: Record<string, unknown>
}

export type StampPreviewVersionOptions = {
  outdir: string
  /** The commit the deploy ships. */
  version: string
  /** The pull request, shown on the System screen. */
  pr?: { number: number; url: string }
  /** Default now. */
  builtAt?: string
  /**
   * The shape of the data the build keeps in the tab (a schema or seed version). Open tabs on a
   * different `stateVersion` say the update resets their data and never apply it on their own.
   */
  stateVersion?: string
}

/**
 * A value as a JavaScript literal for generated module source: JSON with the characters that can
 * end a script or string context escaped.
 */
const literal = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  )

const writeJson = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value)}\n`, "utf8")

/** What `buildPreview` and `devPreview` both make: the app build, the boot loader and the page. */
export type PreviewBuildPlan = {
  workingDir: string
  entryPath: string
  base: string
  /** The app's esbuild options, without where and how the output is written. */
  app: BuildOptions
  /** The boot loader's esbuild options, without where the output is written. */
  loader(boot?: { live?: Record<string, unknown>; dev?: boolean }): BuildOptions
  html: string
  /** The app's hashed entry (`./app-<hash>.js`) among a build's outputs. */
  entryOf(metafile: Metafile, outdir: string): string
}

/** Validates the options and plans the build. */
export function planPreviewBuild(options: Omit<BuildPreviewOptions, "outdir">): PreviewBuildPlan {
  const hostId = options.hostId ?? "preview"
  if (!/^[A-Za-z][\w-]*$/.test(hostId)) throw new Error(`Invalid hostId ${hostId}`)
  const title = options.title ?? "Preview"
  const base = options.base ?? "/"
  if (!/^\/(?:[\w.~-]+\/)*$/.test(base)) throw new Error(`Invalid base ${base}`)
  const extra = (options.esbuild ?? {}) as BuildOptions
  const workingDir = extra.absWorkingDir ?? process.cwd()
  const entryPath = resolve(workingDir, options.entry)
  return {
    workingDir,
    entryPath,
    base,
    // One hashed entry per version, so a new version's entry never collides with the one an open
    // tab is running, and the boot loader can import it into the same page.
    app: {
      bundle: true,
      platform: "browser",
      target: "es2022",
      minify: true,
      ...extra,
      absWorkingDir: workingDir,
      format: "esm",
      entryPoints: { app: entryPath },
      splitting: true,
      metafile: true,
      entryNames: "[name]-[hash]",
      chunkNames: "[name]-[hash]",
      assetNames: "[name]-[hash]",
    },
    // A stable name, loaded by index.html, never swapped.
    loader: (boot = {}) => ({
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      absWorkingDir: workingDir,
      stdin: {
        // `baseUrl` is the loader's own directory, the deployment root, never the page's address:
        // at a deep link the page is `/settings/profile` but version.json is still `/version.json`.
        contents: boot.dev
          ? `import { bootDevPreview } from ${literal(join(here, `dev-boot${extension}`))}\nbootDevPreview({ host: ${literal(`#${hostId}`)}, baseUrl: new URL("./", import.meta.url).href, live: ${literal(boot.live ?? {})} })\n`
          : `import { bootPreview } from ${literal(join(here, `boot${extension}`))}\nbootPreview({ host: ${literal(`#${hostId}`)}, baseUrl: new URL("./", import.meta.url).href }).catch(() => {})\n`,
        resolveDir: here,
        sourcefile: "preview-boot.js",
        loader: "js",
      },
    }),
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>html,body,#${hostId}{height:100%;margin:0}body{font-family:system-ui}</style>
</head><body><main id="${hostId}" aria-label="${escapeHtml(title)}"></main><script type="module" src="${base}preview.js"></script></body></html>
`,
    entryOf(metafile, outdir) {
      const output = Object.entries(metafile.outputs).find(
        ([path, out]) =>
          path.endsWith(".js") &&
          out.entryPoint !== undefined &&
          resolve(workingDir, out.entryPoint) === entryPath,
      )?.[0]
      if (output === undefined) throw new Error("The app build produced no entry")
      return `./${relative(outdir, resolve(workingDir, output)).split(sep).join("/")}`
    },
  }
}

/** Builds the static preview into `outdir` and returns the app's hashed entry (`./app-<hash>.js`). */
export async function buildPreview(options: BuildPreviewOptions): Promise<{ entry: string }> {
  const plan = planPreviewBuild(options)
  const outdir = resolve(plan.workingDir, options.outdir)
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  const app = await build({ ...plan.app, outdir, write: true, metafile: true })
  const entry = plan.entryOf(app.metafile, outdir)
  await build({ ...plan.loader(), outfile: join(outdir, "preview.js") })
  await writeJson(join(outdir, "build.json"), { entry })
  // Deploys overwrite this with the commit they ship (stampPreviewVersion).
  await writeJson(join(outdir, "version.json"), {
    version: "development",
    builtAt: new Date().toISOString(),
    entry,
  })
  await writeFile(join(outdir, "index.html"), plan.html, "utf8")
  return { entry }
}

/**
 * Stamps `version.json` with the commit a deploy ships, just before it deploys. The build may be a
 * cache replay of an older commit's identical output, so the version is stamped rather than built
 * in. Open tabs compare it with the version they run and update.
 */
export async function stampPreviewVersion(options: StampPreviewVersionOptions): Promise<void> {
  if (options.version === "") throw new Error("version is required")
  if (options.stateVersion === "") throw new Error("stateVersion, when given, is not empty")
  const outdir = resolve(options.outdir)
  const manifest = JSON.parse(await readFile(join(outdir, "build.json"), "utf8")) as {
    entry?: unknown
  }
  if (typeof manifest.entry !== "string") throw new Error(`${outdir}/build.json names no entry`)
  const pr = options.pr
  if (pr !== undefined && !(Number.isInteger(pr.number) && pr.number > 0 && pr.url)) {
    throw new Error("pr needs a positive number and a url")
  }
  await writeJson(join(outdir, "version.json"), {
    version: options.version,
    builtAt: options.builtAt ?? new Date().toISOString(),
    entry: manifest.entry,
    ...(pr === undefined ? {} : { pr: { number: pr.number, url: pr.url } }),
    ...(options.stateVersion === undefined ? {} : { stateVersion: options.stateVersion }),
  })
}
