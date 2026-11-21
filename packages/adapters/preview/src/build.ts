/**
 * Builds a static live preview: the app as one hashed entry per version, the stable boot loader
 * (`preview.js`, see `./boot`), `index.html`, `build.json` and a development `version.json`. A
 * deploy then stamps `version.json` with the commit it ships (`stampPreviewVersion`).
 *
 * Bun / Node only (esbuild and the file system). esbuild is a peer dependency.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type BuildOptions, build } from "esbuild"

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

/** Builds the static preview into `outdir` and returns the app's hashed entry (`./app-<hash>.js`). */
export async function buildPreview(options: BuildPreviewOptions): Promise<{ entry: string }> {
  const hostId = options.hostId ?? "preview"
  if (!/^[A-Za-z][\w-]*$/.test(hostId)) throw new Error(`Invalid hostId ${hostId}`)
  const title = options.title ?? "Preview"
  const extra = (options.esbuild ?? {}) as BuildOptions
  const workingDir = extra.absWorkingDir ?? process.cwd()
  const outdir = resolve(workingDir, options.outdir)
  const entryPath = resolve(workingDir, options.entry)
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  // The app: one hashed entry per version, so a new deploy's entry never collides with the one an
  // open tab is running, and the boot loader can import it into the same page.
  const app = await build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify: true,
    ...extra,
    absWorkingDir: workingDir,
    format: "esm",
    entryPoints: { app: entryPath },
    outdir,
    splitting: true,
    metafile: true,
    write: true,
    entryNames: "[name]-[hash]",
    chunkNames: "[name]-[hash]",
    assetNames: "[name]-[hash]",
  })
  const output = Object.entries(app.metafile.outputs).find(
    ([path, out]) =>
      path.endsWith(".js") &&
      out.entryPoint !== undefined &&
      resolve(workingDir, out.entryPoint) === entryPath,
  )?.[0]
  if (output === undefined) throw new Error("The app build produced no entry")
  const entry = `./${basename(output)}`

  // The boot loader: a stable name, loaded by index.html, never swapped.
  await build({
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    absWorkingDir: workingDir,
    stdin: {
      contents: `import { bootPreview } from ${literal(join(here, `boot${extension}`))}\nbootPreview({ host: ${literal(`#${hostId}`)} }).catch(() => {})\n`,
      resolveDir: here,
      sourcefile: "preview-boot.js",
      loader: "js",
    },
    outfile: join(outdir, "preview.js"),
  })

  await writeJson(join(outdir, "build.json"), { entry })
  // Deploys overwrite this with the commit they ship (stampPreviewVersion).
  await writeJson(join(outdir, "version.json"), {
    version: "development",
    builtAt: new Date().toISOString(),
    entry,
  })
  await writeFile(
    join(outdir, "index.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>html,body,#${hostId}{height:100%;margin:0}body{font-family:system-ui}</style>
</head><body><main id="${hostId}" aria-label="${escapeHtml(title)}"></main><script type="module" src="./preview.js"></script></body></html>
`,
    "utf8",
  )
  return { entry }
}

/**
 * Stamps `version.json` with the commit a deploy ships, just before it deploys. The build may be a
 * cache replay of an older commit's identical output, so the version is stamped rather than built
 * in. Open tabs compare it with the version they run and update.
 */
export async function stampPreviewVersion(options: StampPreviewVersionOptions): Promise<void> {
  if (options.version === "") throw new Error("version is required")
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
  })
}
