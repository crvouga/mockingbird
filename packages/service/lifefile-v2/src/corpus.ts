import reference from "./corpus/reference.json" with { type: "json" }
import type {
  Catalog,
  LocationSummary,
  Privilege,
  Settings,
  ShippingServiceSummary,
  StatusSummary,
} from "./types.js"

export const CORPUS_VERSION = reference.version

export const CATALOGS: readonly Catalog[] = ["sandbox", "production"]

export type CatalogData = {
  statuses: readonly StatusSummary[]
  locations: readonly LocationSummary[]
  shippingServices: readonly ShippingServiceSummary[]
}

export const CATALOG_DATA: Record<Catalog, CatalogData> = {
  sandbox: reference.catalogs.sandbox as CatalogData,
  production: reference.catalogs.production as CatalogData,
}

export const SANDBOX_STATUSES = CATALOG_DATA.sandbox.statuses
export const PRODUCTION_STATUSES = CATALOG_DATA.production.statuses

export const PRIVILEGES: readonly Privilege[] = reference.privileges as Privilege[]

export const EXTRA_PRIVILEGES: readonly Privilege[] = [
  {
    id: "practices.shipping-services.list",
    description: "List shipping services assigned to a practice.",
  },
  {
    id: "locations.shipping-configurations.list",
    description: "List a location's carrier-account shipping configurations.",
  },
]

export const DEFAULT_PRIVILEGE_IDS: readonly string[] = PRIVILEGES.map((p) => p.id)

export const describePrivilege = (id: string): Privilege =>
  [...PRIVILEGES, ...EXTRA_PRIVILEGES].find((p) => p.id === id) ?? { id, description: id }

export const DEFAULT_VENDOR_ID = reference.vendorId
export const DEFAULT_PRACTICE = reference.practice
export const DEFAULT_API_USER_ID = reference.apiUserId

export const DEFAULT_CLIENT = { clientId: "lifefile-client", secret: "lifefile-secret" } as const

export const INTAKE_STATUS = "b3644"
export const NEW_STATUS = "new"
export const CANCEL_STATUS = "del"

export const DEFAULT_SETTINGS: Settings = {
  catalog: "sandbox",
  vendorId: DEFAULT_VENDOR_ID,
  enforceVendorId: true,
  openEnrollment: true,
  tokenTtlSeconds: 86_400,
  tokenIdleSeconds: 3_600,
  secretTtlDays: 30,
  fastTrackWindowMs: 2_000,
  fastTrackStatus: INTAKE_STATUS,
  intake: { status: INTAKE_STATUS, afterMs: 500 },
  timeZone: "America/Los_Angeles",
  practice: DEFAULT_PRACTICE,
  rateLimits: { api: 1_000, token: 120 },
  push: null,
  tokenGeneration: 0,
}

export const RECORDED_LATENCY_MS: Readonly<Record<string, number>> = {
  IssueToken: 210,
  RevokeCurrentToken: 200,
  CurrentApiUser: 200,
  RotateCurrentSecret: 250,
  ListOrders: 205,
  CreateOrder: 1_330,
  ShowOrder: 200,
  GetOrderStatus: 205,
  UpdateOrderStatus: 1_100,
  GetOrderShipping: 195,
  UpdateOrderShipping: 215,
  ListLocations: 190,
  ShowLocation: 190,
  ListLocationShippingConfigurations: 185,
  ListShippingServices: 225,
  ListPracticeShippingServices: 190,
  ListStatuses: 185,
  Ping: 190,
}
