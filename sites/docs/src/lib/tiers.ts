import type { ServiceStatus } from "./types.ts"

/**
 * Release tiers, declared by each service as `mockingbird.status` in its package.json.
 * Order matters: the catalog lists ready services first.
 */
export const TIERS = {
  ready: {
    label: "Ready",
    short: "Ready",
    blurb: "Complete, checked against the vendor, and kept stable. Use it in your test suite.",
  },
  wip: {
    label: "Work in progress",
    short: "In progress",
    blurb:
      "Usable, but incomplete: operations, response shapes and options can still change between releases. Pin an exact version.",
  },
} as const satisfies Record<ServiceStatus, { label: string; short: string; blurb: string }>

export const TIER_ORDER: readonly ServiceStatus[] = ["ready", "wip"]

export const isTier = (value: unknown): value is ServiceStatus =>
  typeof value === "string" && Object.hasOwn(TIERS, value)
