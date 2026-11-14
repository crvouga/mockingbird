import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type MetaEvent = {
  id: string
  pixelId: string
  event_name: string
  event_time: number
  event_id: string | null
  action_source: string
  event_source_url: string | null
  user_data: Record<string, unknown>
  custom_data: Record<string, unknown>
  test_event_code: string | null
  accepted_at: number
}

export type MarketingObject = {
  id: string
  kind: "campaign" | "adset" | "ad"
  name: string
  status: string
  objective?: string
}

export type Insight = {
  id: string
  account_id: string
  date_start: string
  date_stop: string
  campaign_id: string
  campaign_name: string
  adset_id?: string
  adset_name?: string
  ad_id?: string
  ad_name?: string
  impressions: string
  clicks: string
  spend: string
  actions: Array<{ action_type: string; value: string }>
  action_values: Array<{ action_type: string; value: string }>
  website_purchase_roas: Array<{ action_type: string; value: string }>
  country?: string
}

/** Graph codes whose envelope is typed `OAuthException`: tokens (190) and rate limits (4, 17, 80004). */
export const OAUTH_CODES: ReadonlySet<number> = new Set([4, 17, 190, 80004])

export type MetaSettings = { accessTokens: string[]; maxEventAgeSeconds: number }
export const DEFAULT_SETTINGS: MetaSettings = { accessTokens: [], maxEventAgeSeconds: 604_800 }

export class MetaState {
  readonly events: Collection<MetaEvent>
  readonly objects: Collection<MarketingObject>
  readonly insights: Collection<Insight>
  readonly settings: Collection<MetaSettings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<MetaSettings> = {},
  ) {
    this.events = new Collection(sqlite, namespace, "events")
    this.objects = new Collection(sqlite, namespace, "objects")
    this.insights = new Collection(sqlite, namespace, "insights")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "meta")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed })
    }
    const fixtures: MarketingObject[] = [
      {
        id: "cmp_mockingbird",
        kind: "campaign",
        name: "Mockingbird launch",
        status: "ACTIVE",
        objective: "OUTCOME_SALES",
      },
      { id: "set_mockingbird", kind: "adset", name: "Synthetic audience", status: "ACTIVE" },
      { id: "ad_mockingbird", kind: "ad", name: "Synthetic creative", status: "ACTIVE" },
    ]
    for (const fixture of fixtures)
      if (!this.objects.has(fixture.id)) this.objects.insert(fixture.id, fixture)
    for (let day = 1; day <= 3; day += 1) {
      const date = `2026-01-0${day}`
      const id = `insight_${day}`
      if (!this.insights.has(id))
        this.insights.insert(id, {
          id,
          account_id: "act_mockingbird",
          date_start: date,
          date_stop: date,
          campaign_id: "cmp_mockingbird",
          campaign_name: "Mockingbird launch",
          adset_id: "set_mockingbird",
          adset_name: "Synthetic audience",
          ad_id: "ad_mockingbird",
          ad_name: "Synthetic creative",
          impressions: String(day * 100),
          clicks: String(day * 10),
          spend: String(day * 12.5),
          actions: [{ action_type: "purchase", value: String(day) }],
          action_values: [{ action_type: "purchase", value: String(day * 50) }],
          website_purchase_roas: [{ action_type: "purchase", value: "4" }],
          country: day % 2 === 0 ? "CA" : "US",
        })
    }
  }

  current(): MetaSettings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<MetaSettings>): MetaSettings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }
}
