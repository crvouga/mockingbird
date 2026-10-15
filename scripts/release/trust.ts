import { publisherGap, type TrustConfig } from "../health/trusted-publisher.ts"

/** Parsed configurations, including the IDs npm requires when replacing one. */
export function trustConfigs(output: string): TrustConfig[] | null {
  try {
    const configs: unknown = JSON.parse(output)
    const list = Array.isArray(configs) ? configs : [configs]
    if (list.some((config) => !config || typeof config !== "object")) return null
    return list as TrustConfig[]
  } catch {
    return null
  }
}

/** Convert npm trust list's CLI fields to the registry shape understood by older seed checkouts. */
export function normalizedTrustConfig(config: TrustConfig): TrustConfig {
  if (!config.file && !config.repository) return config
  return {
    ...config,
    claims: {
      ...config.claims,
      ...(config.repository ? { repository: config.repository } : {}),
      ...(config.file ? { workflow_ref: { file: config.file } } : {}),
    },
  }
}

/** npm trust list --json returns an array. Invalid output never proves a package is trusted. */
export function hasReleasePublisher(output: string): boolean {
  const configs = trustConfigs(output)
  return configs !== null && publisherGap(true, configs.map(normalizedTrustConfig)) === null
}

/** Keep trust failures separate from publish failures: an already-published dependency is usable. */
export function trustedPublisherReconciler(options: {
  list: (name: string) => Promise<string | null>
  revoke: (name: string, id: string) => Promise<boolean>
  create: (name: string) => Promise<boolean>
  onError: (name: string, error: unknown) => void
  /** Recreate matching settings when an actual CI publish rejected them despite matching claims. */
  refresh?: ReadonlySet<string>
  now?: () => number
  sleep?: (ms: number) => Promise<unknown>
}) {
  const failed = new Set<string>()
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  let lastMutationFinishedAt: number | undefined

  async function mutate(operation: () => Promise<boolean>): Promise<boolean> {
    // https://docs.npmjs.com/cli/v11/commands/npm-trust/#bulk-usage
    if (lastMutationFinishedAt !== undefined) {
      const delay = Math.max(0, 2_000 - (now() - lastMutationFinishedAt))
      if (delay > 0) await sleep(delay)
    }
    try {
      return await operation()
    } finally {
      lastMutationFinishedAt = now()
    }
  }

  async function ensure(name: string): Promise<void> {
    // A thrown command is also a failed reconciliation, not an abort of independent packages.
    failed.add(name)
    try {
      const listed = await options.list(name)
      const refresh = options.refresh?.has(name) === true
      if (listed !== null && hasReleasePublisher(listed) && !refresh) {
        failed.delete(name)
        return
      }
      if (listed === null) return
      const configs = trustConfigs(listed)
      if (configs === null) throw new Error("npm trust list returned invalid JSON")

      // Remove the configurations being replaced before creating the corrected publisher.
      // A forced refresh replaces this workflow's matching publishers, preserving other
      // connections on packages that have multiple publishers configured.
      const replace = refresh
        ? configs.filter((config) => hasReleasePublisher(JSON.stringify(config)))
        : configs
      for (const config of replace) {
        if (typeof config.id !== "string" || config.id.length === 0) {
          throw new Error("npm trust list returned a publisher without an id")
        }
        if (!(await mutate(() => options.revoke(name, config.id as string)))) return
      }
      if (!(await mutate(() => options.create(name)))) return
      // A successful settings command is not proof that npm saved a publisher
      // that permits this workflow to publish. Verify the persisted configuration.
      const saved = await options.list(name)
      if (saved === null || !hasReleasePublisher(saved)) {
        throw new Error(
          "npm did not save a Trusted Publisher that allows the Release workflow to publish",
        )
      }
      failed.delete(name)
    } catch (error) {
      options.onError(name, error)
    }
  }

  return { failed, ensure }
}
