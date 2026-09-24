import type { FlagSpec, FlagValue } from "./flags.js"

/** The shape of the consumer app's `docs/feature-flags/state.json` that the importer reads. */
export type FlagStateFile = {
  generatedAt?: string
  flags: {
    flag: string
    posthog: Partial<
      Record<
        string,
        {
          project: string
          projectId?: number
          /** `missing` | `inactive` | `rollout 0` | `targeted` | `ramping` | `live` */
          state: string
          variants?: { variant: string; rolloutPercentage: number }[]
        }[]
      >
    >
  }[]
}

export type ImportOptions = {
  /** `dev` or `prod`. */
  env: string
  /** Which PostHog project's state to take. Default `member-app` (the backend's project too). */
  project?: string
}

/**
 * Map one flag state to what `/flags` answers for a user no targeting names:
 *
 * - `live` → `true`, or the variant with the largest rollout;
 * - `rollout 0`, `targeted`, `ramping` → `false` (a partial rollout is deterministic here: off);
 * - `inactive` and `missing` → absent (PostHog never returns inactive flags).
 */
export const valueForState = (
  state: string,
  variants: { variant: string; rolloutPercentage: number }[] = [],
): FlagValue | null => {
  if (state === "live") {
    const top = [...variants].sort((a, b) => b.rolloutPercentage - a.rolloutPercentage)[0]
    return top?.variant ?? true
  }
  if (state === "rollout 0" || state === "targeted" || state === "ramping") return false
  return null
}

/** Flag specs for one environment/project of a state file. Absent flags are left out. */
export const specsFromState = (
  file: FlagStateFile,
  options: ImportOptions,
): Record<string, FlagSpec> => {
  const project = options.project ?? "member-app"
  const specs: Record<string, FlagSpec> = {}
  for (const entry of file.flags) {
    const row = entry.posthog[options.env]?.find((each) => each.project === project)
    if (!row) continue
    const value = valueForState(row.state, row.variants)
    if (value === null) continue
    specs[entry.flag] = { default: value, payload: null, overrides: [] }
  }
  return specs
}
