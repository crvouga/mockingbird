const DEFAULT_MEDPLUM_VERSION = "v5.1.37"
const CACHE_ROOT_SEGMENTS = ["mockingbird", "medplum-server"]
const HOME_CACHE_ROOT = ".cache"

export type MedplumPathsOptions = {
  version?: string | undefined
  cacheDir?: string | undefined
}

const normalizeVersion = (version: string): string => {
  const trimmed = version.trim()
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`
}

const defaultCacheRoot = (): string => {
  const home = process.env.HOME?.trim()
  if (!home) throw new Error("Cannot resolve the medplum clone cache: HOME is not set")
  return joinPath(home, HOME_CACHE_ROOT, ...CACHE_ROOT_SEGMENTS)
}

export const joinPath = (...segments: string[]): string =>
  segments.filter((s) => s.length > 0).join("/")

export type MedplumPaths = {
  version: string
  cacheRoot: string
  cloneDir: string
  serverEntry: string
  buildMarker: string
}

export const resolveMedplumPaths = (options: MedplumPathsOptions = {}): MedplumPaths => {
  const version = normalizeVersion(
    options.version ?? process.env.MOCKINGBIRD_MEDPLUM_VERSION ?? DEFAULT_MEDPLUM_VERSION,
  )
  const cacheRoot = options.cacheDir ?? process.env.MEDPLUM_MOCK_CACHE_DIR ?? defaultCacheRoot()
  const cloneDir = joinPath(cacheRoot, version)
  return {
    version,
    cacheRoot,
    cloneDir,
    serverEntry: joinPath(cloneDir, "packages", "server", "dist", "index.js"),
    buildMarker: joinPath(cloneDir, ".mockingbird-build-complete"),
  }
}
