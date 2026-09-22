/**
 * Labels for the `mockingbird.category` slug each service declares in its package.json.
 * The build fails if a service names a slug that is not listed here.
 */
export const CATEGORIES = {
  payments: { label: "Payments", blurb: "Charges, subscriptions, checkout and HSA/FSA billing." },
  health: {
    label: "Health & labs",
    blurb: "EHRs, lab ordering, diagnostics, telehealth, nutrition.",
  },
  pharmacy: { label: "Pharmacy", blurb: "eRx, compounding pharmacies and fulfilment." },
  communication: { label: "Communication", blurb: "Email, SMS, chat, video and inbox testing." },
  marketing: { label: "Marketing", blurb: "Customer data, campaigns and referral tracking." },
  ai: {
    label: "AI & speech",
    blurb: "LLM runtimes, retrieval, speech synthesis and transcription.",
  },
  observability: {
    label: "Observability",
    blurb: "Product analytics, feature flags and telemetry.",
  },
  productivity: { label: "Productivity", blurb: "Calendars, issue trackers, CMS and surveys." },
  logistics: { label: "Maps & logistics", blurb: "Places, geocoding and shipment tracking." },
  identity: { label: "Identity", blurb: "Identity verification and KYC." },
  databases: { label: "Databases", blurb: "In-memory SQL engines with real dialect semantics." },
} as const satisfies Record<string, { label: string; blurb: string }>

export type CategorySlug = keyof typeof CATEGORIES

export const isCategory = (slug: string): slug is CategorySlug => Object.hasOwn(CATEGORIES, slug)
