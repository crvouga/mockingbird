/**
 * A port of our backend's Payload CMS client (`apps/backend/src/modules/cms/payload-cms/
 * payload-cms.service.ts`, its mapper and `ReferralContentModel.createDefault`): the same URL
 * and headers, the same fallbacks (no URL, non-2xx, empty docs, a thrown fetch or JSON parse
 * all return the default content) and the same field-by-field merge with the defaults.
 *
 * Seam note: the backend validates `PAYLOAD_CMS_API_URL` as https-only (validation.schema.ts),
 * so a plain-http mock needs that relaxed or a TLS front; the logic below is unchanged.
 */
export type ReferralContent = {
  card: { title: string; subtitle: string; description: string }
  cta: { title: string; actionText: string }
  share: { message: string }
  message: string
}

export type PayloadCmsMarketingDoc = {
  id: number
  name: string
  type: "referral" | "banner" | "email"
  isActive?: boolean
  cardTitle?: string
  cardSubtitle?: string
  cardDescription?: string
  ctaTitle?: string
  ctaActionText?: string
  shareMessage?: string
  updatedAt: string
  createdAt: string
}

export type PayloadCmsCollectionResponse<T> = {
  docs: T[]
  totalDocs: number
  limit: number
  totalPages: number
  page: number
  pagingCounter: number
  hasPrevPage: boolean
  hasNextPage: boolean
  prevPage: number | null
  nextPage: number | null
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const createDefault = (): ReferralContent => {
  const shareMessage = `I've been loving my Geviti membership—it's truly been a game changer in taking my health to the next level. I believe you'll benefit from it too! Use my link to join and get $150 off your membership. Let's boost our wellness together!`
  return {
    card: {
      title: "Earn Rewards",
      subtitle: "Earn Rewards",
      description: "Share your referral link with friends and earn rewards when they sign up.",
    },
    cta: { title: "Share Geviti With Someone You Love", actionText: "Invite Friends" },
    share: { message: shareMessage },
    message: shareMessage,
  }
}

export const toReferralContent = (
  doc: PayloadCmsMarketingDoc,
  defaults: ReferralContent,
): ReferralContent => {
  const shareMessage = doc.shareMessage ?? defaults.share.message
  return {
    card: {
      title: doc.cardTitle ?? defaults.card.title,
      subtitle: doc.cardSubtitle ?? defaults.card.subtitle,
      description: doc.cardDescription ?? defaults.card.description,
    },
    cta: {
      title: doc.ctaTitle ?? defaults.cta.title,
      actionText: doc.ctaActionText ?? defaults.cta.actionText,
    },
    share: { message: shareMessage },
    message: shareMessage,
  }
}

/** `PayloadCmsService`, with its logger captured so tests can tell why it fell back. */
export class PayloadCmsConsumer {
  readonly warnings: string[] = []
  readonly errors: string[] = []

  constructor(
    private readonly apiUrl: string,
    private readonly fetchImpl: Fetch,
  ) {
    if (!this.apiUrl) {
      this.warnings.push(
        "Payload CMS configuration missing. Falling back to default referral content. Set PAYLOAD_CMS_API_URL to enable CMS integration.",
      )
    }
  }

  async getReferralContent(): Promise<ReferralContent> {
    if (!this.apiUrl) {
      this.warnings.push("Payload CMS: Configuration missing. Falling back to default content.")
      return createDefault()
    }
    try {
      const url = `${this.apiUrl}/api/marketing?where[type][equals]=referral&where[isActive][equals]=true&limit=1`
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
      if (!response.ok) {
        this.warnings.push(
          `Failed to fetch referral content from CMS: ${response.status} ${response.statusText}. Falling back to default content.`,
        )
        return createDefault()
      }
      const data = (await response.json()) as PayloadCmsCollectionResponse<PayloadCmsMarketingDoc>
      if (data.docs.length === 0) {
        this.warnings.push(
          "No active referral content found in CMS. Falling back to default content.",
        )
        return createDefault()
      }
      return toReferralContent(data.docs[0] as PayloadCmsMarketingDoc, createDefault())
    } catch (error) {
      this.errors.push("Payload CMS: Error fetching referral content from Payload CMS")
      this.errors.push(error instanceof Error ? error.message : String(error))
      return createDefault()
    }
  }
}
