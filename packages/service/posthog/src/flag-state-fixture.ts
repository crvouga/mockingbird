import type { FlagStateFile } from "./import.js"

function exampleFlag(flag: string, dev: string, prod: string) {
  return {
    flag,
    posthog: {
      dev: [{ project: "member-app", projectId: 101, state: dev }],
      prod: [{ project: "member-app", projectId: 102, state: prod }],
    },
  }
}

/** Synthetic project state used by the CLI seed and admin import defaults. */
export const ACME_FLAG_STATE: FlagStateFile = {
  generatedAt: "2025-01-01T00:00:00Z",
  flags: [
    exampleFlag("example-export", "live", "rollout 0"),
    exampleFlag("example-discounts", "live", "inactive"),
    exampleFlag("example-links", "rollout 0", "targeted"),
    {
      flag: "example-theme",
      posthog: {
        dev: [
          {
            project: "emr",
            projectId: 103,
            state: "live",
            variants: [{ variant: "light", rolloutPercentage: 100 }],
          },
        ],
      },
    },
  ],
}
