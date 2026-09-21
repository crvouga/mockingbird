import { Collection, IdSequence, type OutboxItem, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * One event as Klaviyo stores it, which doubles as the outbox entry a suite asserts on:
 * `to` holds every identifier of the profile it landed on (email, phone, profile id).
 */
export type KlaviyoEvent = OutboxItem & {
  metric: string
  metricId: string
  profileId: string
  uniqueId: string | null
  value: number | null
  valueCurrency: string | null
  /** The event's `properties`, as sent (Klaviyo echoes them back as `event_properties`). */
  properties: Record<string, unknown>
  /** ISO-8601 `time` of the event (the sent `time`, else receipt on the mock clock). */
  time: string
}

/** A profile Klaviyo created (or matched) while ingesting events. */
export type KlaviyoProfile = {
  id: string
  email: string | null
  phone_number: string | null
  external_id: string | null
  created: string
}

export class KlaviyoState {
  readonly events: OutboxStore<KlaviyoEvent>
  readonly profiles: Collection<KlaviyoProfile>
  readonly metrics: Collection<{ id: string; name: string }>
  readonly ids: IdSequence

  constructor(sqlite: SqliteClient, namespace: string) {
    this.events = new OutboxStore<KlaviyoEvent>(sqlite, namespace, "events")
    this.profiles = new Collection(sqlite, namespace, "profiles")
    this.metrics = new Collection(sqlite, namespace, "metrics")
    this.ids = new IdSequence(sqlite, namespace, "klaviyo")
  }

  /** Klaviyo ids are 26-character upper-case ULID-like strings. */
  nextId(kind: "event" | "profile" | "metric"): string {
    if (kind === "metric") return this.ids.next("", 6)
    return this.ids.next(kind === "event" ? "01J" : "01H", 23).toUpperCase()
  }

  /** The metric id for a name, created on first use (Klaviyo creates metrics implicitly). */
  metricId(name: string): string {
    const found = this.metrics.list({ where: (m) => m.name === name }).at(0)?.value
    if (found) return found.id
    const id = this.nextId("metric")
    this.metrics.insert(id, { id, name })
    return id
  }

  /** Match a profile by id, email, phone or external id (in that order), else create one. */
  resolveProfile(
    input: {
      id: string | undefined
      email: string | undefined
      phone_number: string | undefined
      external_id: string | undefined
    },
    created: string,
  ): KlaviyoProfile {
    const all = this.profiles.list({ order: "oldest" }).map((row) => row.value)
    const match =
      (input.id ? all.find((p) => p.id === input.id) : undefined) ??
      (input.email
        ? all.find((p) => p.email?.toLowerCase() === input.email?.toLowerCase())
        : undefined) ??
      (input.phone_number ? all.find((p) => p.phone_number === input.phone_number) : undefined) ??
      (input.external_id ? all.find((p) => p.external_id === input.external_id) : undefined)
    if (match) {
      const merged: KlaviyoProfile = {
        ...match,
        email: match.email ?? input.email ?? null,
        phone_number: match.phone_number ?? input.phone_number ?? null,
        external_id: match.external_id ?? input.external_id ?? null,
      }
      this.profiles.update(match.id, merged)
      return merged
    }
    const profile: KlaviyoProfile = {
      id: input.id || this.nextId("profile"),
      email: input.email ?? null,
      phone_number: input.phone_number ?? null,
      external_id: input.external_id ?? null,
      created,
    }
    this.profiles.insert(profile.id, profile)
    return profile
  }
}
