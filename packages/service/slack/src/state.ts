import { Collection, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * One message the app "sent": an incoming-webhook post or a Web API post. The outbox is the
 * point of this mock, so it keeps the text and blocks (the request journal never does).
 */
export type SlackMessage = {
  id: string
  /** Webhook path (`/services/T/B/X`) and/or channel id and name, for `?to=` matching. */
  to: string[]
  createdAt: string
  source: "webhook" | "api"
  /** The Web API method, or `incoming-webhook`. */
  method: string
  /** `/services/T…/B…/X…` for webhook posts. */
  webhook: string | null
  /** Channel id (`C…`), or the webhook path when the hook has no registered channel. */
  channel: string
  text: string | null
  blocks: unknown[] | null
  attachments: unknown[] | null
  thread_ts: string | null
  ts: string
  /** Bot user id for Web API posts; the ephemeral recipient for `chat.postEphemeral`. */
  user: string | null
  ephemeral: boolean
  edited: { user: string; ts: string } | null
  reactions: { name: string; users: string[]; count: number }[]
}

export type SlackChannel = {
  id: string
  name: string
  is_private: boolean
  is_archived: boolean
  /** Whether the bot is in it (`conversations.join` flips this and warns when already true). */
  is_member: boolean
  created: number
}

export type SlackUser = {
  id: string
  name: string
  real_name: string
  email: string | null
  is_bot: boolean
  deleted: boolean
  tz: string
}

export type SlackFile = {
  id: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  created: number
}

/** A registered incoming webhook: the path suffix `T…/B…/X…` and the channel it posts to. */
export type SlackHook = { path: string; channel: string }

export type SlackView = Record<string, unknown> & { id: string }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Workspace identity `auth.test` and permalinks report. */
  teamId: string
  teamName: string
  teamDomain: string
  botUserId: string
  botId: string
  appId: string
  /**
   * Tokens the Web API accepts. Empty (the default) accepts any `xoxb-`/`xoxp-`/`xoxa-`
   * token; anything else is `invalid_auth`, a missing token `not_authed`.
   */
  tokens: string[]
  /**
   * Unknown channels answer `channel_not_found` when true. Default false: any channel id or
   * name is created on first use, so a suite need not seed the app's channel ids.
   */
  strictChannels: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  teamId: "T0MOCKBIRD",
  teamName: "Mockingbird",
  teamDomain: "mockingbird",
  botUserId: "U0MOCKBOT",
  botId: "B0MOCKBOT",
  appId: "A0MOCKAPP",
  tokens: [],
  strictChannels: false,
}

export const DEFAULT_CHANNELS: readonly SlackChannel[] = [
  {
    id: "C0GENERAL",
    name: "general",
    is_private: false,
    is_archived: false,
    is_member: true,
    created: 1_700_000_000,
  },
  {
    id: "C0ALERTS",
    name: "alerts",
    is_private: false,
    is_archived: false,
    is_member: false,
    created: 1_700_000_000,
  },
]

export const DEFAULT_USERS: readonly SlackUser[] = [
  {
    id: "U0MOCKBOT",
    name: "mockingbird",
    real_name: "Mockingbird Bot",
    email: null,
    is_bot: true,
    deleted: false,
    tz: "America/Los_Angeles",
  },
  {
    id: "U0ADA",
    name: "ada",
    real_name: "Ada Lovelace",
    email: "ada@example.com",
    is_bot: false,
    deleted: false,
    tz: "America/Los_Angeles",
  },
]

export const DEFAULT_FILES: readonly SlackFile[] = [
  {
    id: "F0REPORT",
    name: "lab-report.pdf",
    title: "lab-report.pdf",
    mimetype: "application/pdf",
    filetype: "pdf",
    size: 48_213,
    created: 1_700_000_000,
  },
]

export class SlackState {
  readonly outbox: OutboxStore<SlackMessage>
  readonly channels: Collection<SlackChannel>
  readonly users: Collection<SlackUser>
  readonly files: Collection<SlackFile>
  readonly hooks: Collection<SlackHook>
  readonly views: Collection<SlackView>
  readonly settings: Collection<Settings>
  /** Only its sequence is used: the microsecond part of every `ts`. */
  private readonly tsCounter: Collection<never>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings> },
  ) {
    this.outbox = new OutboxStore<SlackMessage>(sqlite, namespace)
    this.channels = new Collection(sqlite, namespace, "channels")
    this.users = new Collection(sqlite, namespace, "users")
    this.files = new Collection(sqlite, namespace, "files")
    this.hooks = new Collection(sqlite, namespace, "hooks")
    this.views = new Collection(sqlite, namespace, "views")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.tsCounter = new Collection(sqlite, namespace, "ts")
    this.ensureSeeded()
  }

  /** Re-apply the default workspace after a reset. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
    if (this.channels.count() === 0) {
      for (const channel of DEFAULT_CHANNELS) this.channels.insert(channel.id, channel)
    }
    if (this.users.count() === 0) {
      const bot = this.current().botUserId
      for (const user of DEFAULT_USERS) {
        const id = user.is_bot ? bot : user.id
        this.users.insert(id, { ...user, id })
      }
    }
    if (this.files.count() === 0) {
      for (const file of DEFAULT_FILES) this.files.insert(file.id, file)
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** `1700000000.000042`: mock-clock seconds, then a per-namespace counter as microseconds. */
  nextTs(nowMs: number): string {
    const seq = this.tsCounter.nextSequence() % 1_000_000
    return `${Math.floor(nowMs / 1000)}.${String(seq).padStart(6, "0")}`
  }

  /** By id (`C…`), or by name with or without `#`. */
  findChannel(ref: string): SlackChannel | undefined {
    const byId = this.channels.get(ref)
    if (byId) return byId
    const name = ref.replace(/^#/, "").toLowerCase()
    return this.channels.list({ where: (c) => c.name === name }).at(0)?.value
  }

  findUserByEmail(email: string): SlackUser | undefined {
    const wanted = email.toLowerCase()
    return this.users.list({ where: (u) => u.email?.toLowerCase() === wanted }).at(0)?.value
  }

  /** The message `ts` in `channel` (webhook posts are addressed by their hook's channel). */
  findMessage(channel: string, ts: string): SlackMessage | undefined {
    return this.outbox
      .list({ where: (m) => m.ts === ts && !m.ephemeral && m.channel === channel })
      .at(0)
  }
}
