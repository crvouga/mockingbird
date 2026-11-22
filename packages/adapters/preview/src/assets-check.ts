/**
 * Preflight of a built preview against the host's asset limits, before anything is uploaded:
 * every file over the per-file limit, the file count against the per-deployment limit, and
 * anything that is not a regular file or directory (a symlink, a socket, a device). With `split`,
 * files over the limit are first split into numbered parts next to a SHA-256 manifest
 * (`./split-load.ts` joins them in the browser).
 *
 * Bun / Node only (the file system).
 */
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { digestPreviewBytes } from "./artifacts.js"
import {
  PREVIEW_SPLIT_MANIFEST_SUFFIX,
  type PreviewSplitManifest,
  previewSplitPartName,
} from "./split-load.js"

const MIB = 1024 * 1024

/** Per-file size and per-deployment file count a host accepts. */
export type PreviewAssetLimits = { maxFileBytes: number; maxFiles: number }

/**
 * The defaults per host. Cloudflare is Workers static assets' documented limits (25 MiB per file,
 * 20 000 files per version on the free plan). Vercel's are a **best guess, not verified** against
 * a live account (100 MiB per file, 15 000 files); override them for your plan.
 */
export const PREVIEW_ASSET_LIMITS = {
  cloudflare: { maxFileBytes: 25 * MIB, maxFiles: 20_000 },
  vercel: { maxFileBytes: 100 * MIB, maxFiles: 15_000 },
} as const satisfies Record<string, PreviewAssetLimits>

export type PreviewAssetProblem =
  | { kind: "too-large"; path: string; bytes: number }
  | { kind: "too-many"; files: number }
  | { kind: "not-a-file"; path: string }

export type PreviewAssetReport = {
  files: number
  bytes: number
  /** Every file split into parts (the original paths). */
  split: string[]
  problems: PreviewAssetProblem[]
}

/** Thrown by `assertPreviewAssets`; its message names every offending path. */
export class PreviewAssetLimitError extends Error {
  constructor(
    readonly problems: PreviewAssetProblem[],
    limits: PreviewAssetLimits,
  ) {
    super(formatPreviewAssetProblems(problems, limits))
    this.name = "PreviewAssetLimitError"
  }
}

const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`

/** One line per problem, for a log or an error. */
export function formatPreviewAssetProblems(
  problems: readonly PreviewAssetProblem[],
  limits: PreviewAssetLimits,
): string {
  return problems
    .map((problem) =>
      problem.kind === "too-large"
        ? `${problem.path} is ${mib(problem.bytes)}, over the ${mib(limits.maxFileBytes)} per-file limit (split it: mockingbird-preview check --split)`
        : problem.kind === "too-many"
          ? `${problem.files} files, over the ${limits.maxFiles} files per deployment limit`
          : `${problem.path} is not a regular file (symlinks and special files are refused)`,
    )
    .join("\n")
}

type Entry = { path: string; abs: string; bytes: number }

const walk = async (root: string) => {
  const files: Entry[] = []
  const special: string[] = []
  const visit = async (folder: string) => {
    const entries = await readdir(folder, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const abs = join(folder, entry.name)
      const path = relative(root, abs).split(sep).join("/")
      const stat = await lstat(abs)
      if (stat.isDirectory()) await visit(abs)
      else if (stat.isFile()) files.push({ path, abs, bytes: stat.size })
      else special.push(path)
    }
  }
  await visit(root)
  return { files, special }
}

/** Splits `file` into parts of at most `partBytes` next to its manifest, then removes it. */
async function splitOne(abs: string, partBytes: number): Promise<PreviewSplitManifest> {
  const bytes = new Uint8Array(await readFile(abs))
  const name = basename(abs)
  const parts: PreviewSplitManifest["parts"] = []
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += partBytes, index++) {
    const chunk = bytes.subarray(offset, Math.min(offset + partBytes, bytes.byteLength))
    const path = previewSplitPartName(name, index)
    await writeFile(join(dirname(abs), path), chunk)
    parts.push({ path, bytes: chunk.byteLength, sha256: await digestPreviewBytes(chunk) })
  }
  const manifest: PreviewSplitManifest = {
    format: 1,
    path: name,
    bytes: bytes.byteLength,
    sha256: await digestPreviewBytes(bytes),
    parts,
  }
  await writeFile(
    `${abs}${PREVIEW_SPLIT_MANIFEST_SUFFIX}`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await rm(abs)
  return manifest
}

/**
 * Checks `dir` against `limits` (default Cloudflare's). With `split: true`, every file over the
 * per-file limit is first split into parts of at most that size (`<file>.part-NNN` plus
 * `<file>.parts.json`), so only the count can still fail.
 */
export async function checkPreviewAssets(
  dir: string,
  options: { limits?: Partial<PreviewAssetLimits>; split?: boolean } = {},
): Promise<PreviewAssetReport> {
  const limits = { ...PREVIEW_ASSET_LIMITS.cloudflare, ...(options.limits ?? {}) }
  if (!(limits.maxFileBytes > 0 && limits.maxFiles > 0))
    throw new Error("Preview asset limits are positive numbers")
  const root = resolve(dir)
  let { files, special } = await walk(root)
  const split: string[] = []
  if (options.split) {
    for (const file of files.filter((entry) => entry.bytes > limits.maxFileBytes)) {
      await splitOne(file.abs, limits.maxFileBytes)
      split.push(file.path)
    }
    if (split.length > 0) ({ files, special } = await walk(root))
  }
  const problems: PreviewAssetProblem[] = [
    ...special.map((path) => ({ kind: "not-a-file" as const, path })),
    ...files
      .filter((file) => file.bytes > limits.maxFileBytes)
      .map((file) => ({ kind: "too-large" as const, path: file.path, bytes: file.bytes })),
    ...(files.length > limits.maxFiles ? [{ kind: "too-many" as const, files: files.length }] : []),
  ]
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    split,
    problems,
  }
}

/** `checkPreviewAssets`, throwing a `PreviewAssetLimitError` naming every problem. */
export async function assertPreviewAssets(
  dir: string,
  options: { limits?: Partial<PreviewAssetLimits>; split?: boolean } = {},
): Promise<PreviewAssetReport> {
  const limits = { ...PREVIEW_ASSET_LIMITS.cloudflare, ...(options.limits ?? {}) }
  const report = await checkPreviewAssets(dir, { ...options, limits })
  if (report.problems.length > 0) throw new PreviewAssetLimitError(report.problems, limits)
  return report
}
