import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** A Payload document: an integer id, timestamps, and whatever fields its collection has. */
export type PayloadDoc = {
  id: number
  createdAt: string
  updatedAt: string
  [field: string]: unknown
}

/** One collection: its documents and the next id Payload's Postgres adapter would issue. */
export type CollectionRecord = { slug: string; docs: PayloadDoc[]; nextId: number }

/** The Marketing collection fields the referral card reads (camelCase, as Payload's API returns). */
export const MARKETING_FIELDS = [
  "id",
  "name",
  "type",
  "isActive",
  "cardTitle",
  "cardSubtitle",
  "cardDescription",
  "ctaTitle",
  "ctaActionText",
  "shareMessage",
  "createdAt",
  "updatedAt",
] as const

/**
 * The seed every namespace starts with: one active referral card (what the app shows), an
 * active banner, and an older inactive referral card the `isActive` filter must skip.
 */
export const DEFAULT_MARKETING_DOCS: readonly PayloadDoc[] = [
  {
    id: 1,
    name: "Referral card (spring)",
    type: "referral",
    isActive: false,
    cardTitle: "Spring Rewards",
    cardSubtitle: "Old campaign",
    cardDescription: "An inactive card the isActive filter must skip.",
    ctaTitle: "Old CTA",
    ctaActionText: "Old action",
    shareMessage: "Old share message",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  },
  {
    id: 2,
    name: "Referral card",
    type: "referral",
    isActive: true,
    cardTitle: "Give $150, Get Rewarded",
    cardSubtitle: "Refer a friend",
    cardDescription: "Share your link. Friends get $150 off their membership.",
    ctaTitle: "Share Geviti With Someone You Love",
    ctaActionText: "Invite Friends",
    shareMessage: "Join me on Geviti and get $150 off your membership.",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
  {
    id: 3,
    name: "Home banner",
    type: "banner",
    isActive: true,
    cardTitle: "New: at-home blood draws",
    cardSubtitle: null,
    cardDescription: null,
    ctaTitle: null,
    ctaActionText: null,
    shareMessage: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
]

export type Seed = Record<string, readonly PayloadDoc[]>

export class PayloadState {
  readonly collections: Collection<CollectionRecord>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Seed,
  ) {
    this.collections = new Collection(sqlite, namespace, "collections")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.collections.count() > 0) return
    const seed =
      Object.keys(this.seed).length > 0 ? this.seed : { marketing: DEFAULT_MARKETING_DOCS }
    for (const [slug, docs] of Object.entries(seed)) this.replace(slug, docs)
  }

  get(slug: string): CollectionRecord | undefined {
    return this.collections.get(slug)
  }

  replace(slug: string, docs: readonly PayloadDoc[]): CollectionRecord {
    const record: CollectionRecord = {
      slug,
      docs: [...docs],
      nextId: docs.reduce((max, doc) => Math.max(max, doc.id), 0) + 1,
    }
    this.collections.insert(slug, record)
    return record
  }

  save(record: CollectionRecord): void {
    this.collections.insert(record.slug, record)
  }
}
