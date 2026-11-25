export type Catalog = "sandbox" | "production"

export type StatusSummary = { id: string; label: string }

export type LocationSummary = { id: number; name: string; shortName: string }

export type ShippingServiceSummary = {
  id: number
  name: string
  type: string
  price: number
  carrier: string | null
  carrierKey: string | null
  serviceCode: string | null
  visibleToDoctors: boolean
  visibleToPatients: boolean
  sortPosition: number
  color: string | null
}

export type Privilege = { id: string; description: string }

export type ApiUser = {
  clientId: string
  secret: string
  secretIssuedAt: number
  generation: number
  userId: number
  vendorId: number
  practiceId: number
  userGroup: "api-practice" | "api-pharmacy"
  privileges: string[]
}

export type TokenRecord = {
  tokenId: number
  clientId: string
  issuedAt: number
  lastUsedAt: number
  revoked: boolean
}

export type Intake = { status: string; afterMs: number }

export type PushTarget = { url: string; username: string; password: string }

export type RateLimits = { api: number; token: number }

export type Settings = {
  catalog: Catalog
  vendorId: number
  enforceVendorId: boolean
  openEnrollment: boolean
  tokenTtlSeconds: number
  tokenIdleSeconds: number
  secretTtlDays: number
  fastTrackWindowMs: number
  fastTrackStatus: string
  intake: Intake | null
  timeZone: string
  practice: { id: number; name: string }
  rateLimits: RateLimits | null
  push: PushTarget | null
  tokenGeneration: number
}

export type ShippingRecord = {
  recipientType: string | null
  recipientLastName: string | null
  recipientFirstName: string | null
  company: string | null
  attention: string | null
  recipientPhone: string | null
  recipientEmail: string | null
  addressLine1: string | null
  addressLine2: string | null
  addressLine3: string | null
  city: string | null
  state: string | null
  zipCode: string | null
  country: string | null
  service: number | null
  handlingService: number | null
  signatureType: string | null
  insuranceAmount: number | null
  thirdPartyBillingAccount: string | null
  saturdayDelivery: boolean | null
  fedExPriorityAlert: string | null
  residentialAddressIndicator: string | null
}

export type RxRecord = {
  fillId: number | null
  rxType: string | null
  rxNumber: string | null
  drugName: string | null
  drugStrength: string | null
  drugForm: string | null
  quantity: string | null
  quantityUnits: string | null
  directions: string | null
  refills: number | null
  daysSupply: number | null
  scheduleCode: string | null
  clinicalDifferenceStatement: string | null
  note: string | null
  uuid: string
}

export type TrackingRecord = {
  trackingNumber: string
  carrier: string | null
  service: string | null
}

export type OrderRecord = {
  id: number
  sequence: number
  createdAt: number
  lastUpdatedAt: number
  statusId: string
  statusWritten: boolean
  touched: boolean
  general: { memo: string | null; referenceId: string | null }
  locationId: number
  prescriber: Record<string, string | number | null>
  practice: { id: number; name: string }
  patient: Record<string, string | number | null>
  shipping: ShippingRecord
  billing: { payorType: string | null }
  rxs: RxRecord[]
  messageId: string | number | null
  tracking: TrackingRecord | null
}

export type StatusChange = {
  order: OrderRecord
  previous: string
  current: string
  source: "api" | "fast_track" | "intake" | "admin"
}
