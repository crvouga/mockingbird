import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  ProviderExpansion,
  type ProviderOptions,
  type SlackSeedConfig,
  seedSlack,
  selectOperations,
  slackPlugin,
} from "@crvouga/mockingbird-http-provider"
import {
  ADMIN_PREFIX,
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  matchNamespacePath,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Hono } from "hono"
import { attachmentBlockIssues, blockIssues } from "./blocks.js"
import { syncFromExpanded, syncToExpanded } from "./expanded-state.js"
import { document } from "./generated/openapi.js"
import { type NativeOperationId, nativeOperationIds } from "./native-operations.js"
import { closeSocketNamespace, issueSocketTicket } from "./sockets.js"
import {
  type Settings,
  type SlackChannel,
  type SlackFile,
  type SlackMessage,
  SlackState,
  type SlackUser,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  Settings,
  SlackChannel,
  SlackFile,
  SlackHook,
  SlackMessage,
  SlackUser,
  SlackView,
} from "./state.js"
export { DEFAULT_CHANNELS, DEFAULT_FILES, DEFAULT_SETTINGS, DEFAULT_USERS } from "./state.js"

export const SLACK_NAMESPACE = "slack"

export type SlackAPIOptions = APIOptions &
  Pick<ProviderOptions, "tokens" | "baseUrl" | "publicNamespace" | "adminPrefix" | "random"> & {
    fixtures?: SlackSeedConfig
    /** Initial per-namespace settings (workspace identity, accepted tokens, strict channels). */
    settings?: Partial<Settings>
    /**
     * Public namespace (`default`, or the `x-mockingbird-namespace` value). Socket records are
     * keyed by this, which is what `/__admin` selects. `namespace` is the storage key.
     */
    publicNamespace?: string
  }

const WEBHOOK_PATH = /^\/services\/([^/]+\/[^/]+\/[^/]+)\/?$/

/**
 * The credential a Slack request carries, for `PUT /__admin/credentials`: the Web API bearer
 * token, or an incoming webhook's `T…/B…/X…` path (the webhook URL is its own credential).
 */
export const slackCredential = (
  request: Request,
  adminPrefix = ADMIN_PREFIX,
): string | undefined => {
  const token = bearerToken(request)
  if (token) return token
  const path = new URL(request.url).pathname
  return WEBHOOK_PATH.exec(matchNamespacePath(path, adminPrefix)?.[2] ?? path)?.[1]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  })

/** Slack answers logical failures with HTTP 200 and `{ok: false, error}`. */
const fail = (error: string, extra: Record<string, unknown> = {}) =>
  jsonRes(200, { ok: false, error, ...extra })

/** Thrown inside a handler to answer `{ok: false, error}`. */
class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

type Reply = { body: Record<string, unknown>; ids?: Record<string, string> }

const reply = (body: Record<string, unknown>, ids?: { ids: Record<string, string> }): Reply =>
  ids ? { body, ids: ids.ids } : { body }

type Args = Record<string, unknown> & { __json: boolean; __charset: boolean }

/**
 * Web API arguments the way Slack reads them: query string, then a form body or a JSON body
 * (Slack accepts both for write methods). Form fields that carry structures (`blocks`,
 * `attachments`, `view`) arrive JSON-encoded and are decoded here.
 */
const readArgs = (context: OperationContext): Args => {
  const args: Record<string, unknown> = {}
  for (const [key, value] of context.url.searchParams) args[key] = value
  const body = context.body
  const contentType = context.request.headers.get("content-type") ?? ""
  let json = false
  if (body.kind === "json") {
    if (!isRecord(body.value)) throw new SlackError("invalid_json")
    Object.assign(args, body.value)
    json = true
  } else if (body.kind === "form") {
    Object.assign(args, body.value)
    for (const key of ["blocks", "attachments", "view"]) {
      const raw = args[key]
      if (typeof raw !== "string") continue
      try {
        args[key] = JSON.parse(raw)
      } catch {
        throw new SlackError(key === "blocks" ? "invalid_blocks_format" : "invalid_arguments", {
          response_metadata: { messages: [`[ERROR] ${key} must be valid JSON`] },
        })
      }
    }
  } else if (body.kind === "invalid") {
    throw new SlackError("invalid_json")
  }
  return Object.assign(args, { __json: json, __charset: /charset=/i.test(contentType) })
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined

/** Slack app-level tokens (`xapp-1-A…-…`). Bot tokens are a different credential. */
const APP_TOKEN = /^xapp-[A-Za-z0-9][A-Za-z0-9_-]{8,}$/

const flag = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return null
}

const invalidBlocks = (issues: string[]) =>
  new SlackError("invalid_blocks", {
    response_metadata: { messages: issues.map((issue) => `[ERROR] ${issue}`) },
  })

/** Blocks must be an array of Block Kit blocks within their documented limits (see `blocks.ts`). */
const checkBlocks = (blocks: unknown): unknown[] | null => {
  if (blocks === undefined || blocks === null || blocks === "") return null
  const issues = blockIssues(blocks)
  if (issues.length > 0) throw invalidBlocks(issues)
  return blocks as unknown[]
}

/** The same limits for the `blocks` carried inside `attachments[]`; the attachments are stored as sent. */
const checkAttachments = (attachments: unknown): unknown[] | null => {
  if (!Array.isArray(attachments)) return null
  const issues = attachmentBlockIssues(attachments)
  if (issues.length > 0) throw invalidBlocks(issues)
  return attachments
}

/**
 * Stateful mock of Slack incoming webhooks and the Web API methods our apps call.
 *
 * Every post lands in the namespace's outbox (`GET /__admin/outbox`), with its text, blocks,
 * `thread_ts` and the `ts` Slack would assign, so a suite can assert that an alert fired.
 */
export class SlackAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: SlackState
  private tail: Promise<unknown> = Promise.resolve()
  private readonly expansion: ProviderExpansion
  private readonly service: Service
  private readonly now: () => number
  private readonly namespaceName: string

  constructor(options: SlackAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? SLACK_NAMESPACE
    this.namespaceName = options.publicNamespace ?? "default"
    this.now = options.now ?? (() => Date.now())
    this.state = new SlackState(sqlite, namespace, { settings: options.settings ?? {} })
    const api =
      (fn: (args: Args, context: OperationContext) => Reply) => (context: OperationContext) => {
        try {
          const args = readArgs(context)
          const { body, ids } = fn(args, context)
          // Real Slack still succeeds, with a warning, when a JSON post omits the charset.
          const warn = args.__json && !args.__charset
          const response = jsonRes(
            200,
            warn
              ? {
                  ...body,
                  warning: "missing_charset",
                  response_metadata: { warnings: ["missing_charset"] },
                }
              : body,
          )
          return ids ? annotateResponse(response, { ids }) : response
        } catch (error) {
          if (error instanceof SlackError) return fail(error.code, error.extra)
          throw error
        }
      }
    const handlers = defineOperations<NativeOperationId>({
      PostIncomingWebhook: (context) => this.incomingWebhook(context),
      ChatPostMessage: api((args, context) => this.postMessage(args, context)),
      ChatUpdate: api((args, context) => this.update(args, context)),
      ChatPostEphemeral: api((args, context) => this.postEphemeral(args, context)),
      ChatGetPermalink: api((args, context) => this.permalink(args, context)),
      ChatGetPermalinkGet: api((args, context) => this.permalink(args, context)),
      ReactionsAdd: api((args, context) => this.react(args, context, "add")),
      ReactionsRemove: api((args, context) => this.react(args, context, "remove")),
      ReactionsGet: api((args, context) => this.reactions(args, context)),
      ReactionsGetGet: api((args, context) => this.reactions(args, context)),
      AuthTest: api(() => this.authTest()),
      AuthTestGet: api(() => this.authTest()),
      ConversationsJoin: api((args, context) => this.join(args, context)),
      UsersInfo: api((args) => this.userInfo(args)),
      UsersInfoGet: api((args) => this.userInfo(args)),
      UsersLookupByEmail: api((args) => this.lookupByEmail(args)),
      UsersLookupByEmailGet: api((args) => this.lookupByEmail(args)),
      FilesInfo: api((args) => this.fileInfo(args)),
      FilesInfoGet: api((args) => this.fileInfo(args)),
      ViewsOpen: api((args) => this.openView(args)),
      AppsConnectionsOpen: (context) => this.connectionsOpen(context),
    })
    this.service = createService({
      document: selectOperations(document, nativeOperationIds),
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        new URL(request.url).pathname.startsWith("/api/")
          ? fail("unknown_method")
          : text(404, "no_service"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => this.gate(context),
    })
    this.app = new Hono().all("*", (c) => this.fetch(c.req.raw))
    this.sqlite = this.service.sqlite
    this.expansion = new ProviderExpansion(
      slackPlugin,
      selectOperations(document, nativeOperationIds),
      {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
        ...(options.random ? { random: options.random } : {}),
        ...(options.publicNamespace !== undefined
          ? { publicNamespace: options.publicNamespace }
          : {}),
        ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
        sqlite,
        namespace,
        now: this.now,
        fallbackUser: { login: this.state.current().botUserId, id: 1, scopes: [] },
      },
    )
    if (options.fixtures) {
      this.expansion.configureFixtures(options.fixtures, seedSlack)
      syncFromExpanded(this.state, this.expansion)
    }
  }

  fetch(request: Request): Promise<Response> {
    const result = this.tail.then(
      () => this.handleFetch(request),
      () => this.handleFetch(request),
    )
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  private async handleFetch(request: Request): Promise<Response> {
    if (this.expansion.handles(request)) {
      syncToExpanded(this.state, this.expansion)
      const path = new URL(request.url).pathname
      if (path.startsWith("/api/") && !path.includes("oauth")) {
        let token = bearerToken(request) ?? new URL(request.url).searchParams.get("token")
        if (
          !token &&
          request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
        )
          token = String((await request.clone().formData()).get("token") ?? "")
        if (!token) return fail("not_authed")
        const accepted = this.settings().tokens
        if (!(accepted.length ? accepted.includes(token) : /^xox[abp]-/.test(token)))
          return fail("invalid_auth")
        if (!bearerToken(request)) {
          const headers = new Headers(request.headers)
          headers.set("authorization", `Bearer ${token}`)
          request = new Request(request, { headers })
        }
      }
      const response = await this.expansion.fetch(request)
      syncFromExpanded(this.state, this.expansion)
      return response
    }
    const response = await this.service.fetch(request)
    return response
  }

  async reset(): Promise<void> {
    await this.tail
    closeSocketNamespace(this.namespaceName)
    await this.service.reset()
    await this.expansion.reset()
    syncFromExpanded(this.state, this.expansion)
    this.state.ensureSeeded()
  }

  /** Every message in the outbox, oldest first. */
  messages(): SlackMessage[] {
    return this.state.outbox.list()
  }

  private settings(): Settings {
    return this.state.current()
  }

  /** Fault effects every surface shares, then Web API authentication. */
  private gate(context: OperationContext): Response | undefined {
    const webhook = context.operation.operationId === "PostIncomingWebhook"
    const limited = faultEffect(context.request, "rate_limited")
    if (limited !== undefined) {
      const retryAfter = String(limited.retryAfter ?? 1)
      return webhook
        ? text(429, "rate_limited", { "retry-after": retryAfter })
        : jsonRes(429, { ok: false, error: "ratelimited" }, { "retry-after": retryAfter })
    }
    const broken = faultEffect(context.request, "server_error")
    if (broken !== undefined) {
      const status = typeof broken.status === "number" ? broken.status : 500
      const code = status === 503 ? "service_unavailable" : "internal_error"
      return webhook ? text(status, code) : jsonRes(status, { ok: false, error: code })
    }
    if (webhook || context.operation.operationId === "AppsConnectionsOpen") return undefined
    if (faultEffect(context.request, "invalid_auth") !== undefined) return fail("invalid_auth")
    const token = bearerToken(context.request) ?? this.bodyToken(context)
    if (!token) return fail("not_authed")
    const accepted = this.settings().tokens
    const ok = accepted.length > 0 ? accepted.includes(token) : /^xox[abp]-/.test(token)
    return ok ? undefined : fail("invalid_auth")
  }

  /** Form posts may carry `token=` instead of the header (Slack's legacy style). */
  private bodyToken(context: OperationContext): string | undefined {
    const fromQuery = context.url.searchParams.get("token")
    if (fromQuery) return fromQuery
    return context.body.kind === "form" ? str(context.body.value.token) : undefined
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /**
   * Resolve a channel id or name. Unknown channels are created on first use unless
   * `strictChannels` is set; the `channel_not_found` preset forces the error.
   */
  private channel(ref: unknown, context: OperationContext): SlackChannel {
    const wanted = str(ref)
    if (!wanted || faultEffect(context.request, "channel_not_found") !== undefined) {
      throw new SlackError("channel_not_found")
    }
    const found = this.state.findChannel(wanted)
    if (found) return found
    if (this.settings().strictChannels) throw new SlackError("channel_not_found")
    const isId = /^[CGD][A-Z0-9]{2,}$/.test(wanted)
    const name = isId ? wanted.toLowerCase() : wanted.replace(/^#/, "").toLowerCase()
    const created: SlackChannel = {
      id: isId ? wanted : `C${opaqueToken(`channel:${name}`, 10).toUpperCase()}`,
      name,
      is_private: wanted.startsWith("G"),
      is_archived: false,
      is_member: true,
      created: Math.floor(this.now() / 1000),
    }
    this.state.channels.insert(created.id, created)
    return created
  }

  private messageBody(message: SlackMessage) {
    const settings = this.settings()
    return {
      type: "message" as const,
      ...(message.text !== null ? { text: message.text } : { text: "" }),
      user: settings.botUserId,
      bot_id: settings.botId,
      app_id: settings.appId,
      team: settings.teamId,
      ts: message.ts,
      ...(message.thread_ts !== null ? { thread_ts: message.thread_ts } : {}),
      ...(message.blocks !== null ? { blocks: message.blocks } : {}),
      ...(message.edited !== null ? { edited: message.edited } : {}),
      ...(message.reactions.length > 0 ? { reactions: message.reactions } : {}),
    }
  }

  private record(
    message: Omit<SlackMessage, "id" | "createdAt" | "reactions" | "workspace">,
  ): SlackMessage {
    const stored: SlackMessage = {
      ...message,
      id: `${message.channel}:${message.ts}`,
      createdAt: this.iso(),
      reactions: [],
      workspace: this.settings().teamId,
    }
    return this.state.outbox.record(stored)
  }

  private incomingWebhook(context: OperationContext): Response {
    const path = `${context.params.team}/${context.params.bot}/${context.params.secret}`
    const webhook = `/services/${path}`
    const hooks = this.state.hooks.list()
    const hook = this.state.hooks.get(path)
    if (hooks.length > 0 && !hook) return text(404, "no_service")
    if (faultEffect(context.request, "no_service") !== undefined) return text(404, "no_service")
    if (faultEffect(context.request, "channel_not_found") !== undefined) {
      return text(404, "channel_not_found")
    }
    let payload: unknown
    const body = context.body
    if (body.kind === "json") payload = body.value
    else if (body.kind === "form" && typeof body.value.payload === "string") {
      try {
        payload = JSON.parse(body.value.payload)
      } catch {
        return text(400, "invalid_payload")
      }
    } else return text(400, "invalid_payload")
    if (!isRecord(payload)) return text(400, "invalid_payload")
    let blocks: unknown[] | null
    let attachments: unknown[] | null
    try {
      blocks = checkBlocks(payload.blocks)
      attachments = checkAttachments(payload.attachments)
    } catch {
      return text(400, "invalid_blocks")
    }
    if (attachments && attachments.length > 100) return text(400, "too_many_attachments")
    const messageText = typeof payload.text === "string" ? payload.text : null
    if (!messageText && !blocks && !attachments) return text(400, "no_text")
    const channel = hook ? this.state.findChannel(hook.channel) : undefined
    if (channel?.is_archived) return text(410, "channel_is_archived")
    const ts = this.state.nextTs(this.now())
    const target = channel?.id ?? hook?.channel ?? webhook
    const message = this.record({
      to: [webhook, ...(channel ? [channel.id, `#${channel.name}`] : hook ? [hook.channel] : [])],
      source: "webhook",
      method: "incoming-webhook",
      webhook,
      channel: target,
      text: messageText,
      blocks,
      attachments,
      thread_ts: str(payload.thread_ts) ?? null,
      ts,
      user: null,
      ephemeral: false,
      edited: null,
      unfurl_links: flag(payload.unfurl_links),
    })
    return annotateResponse(text(200, "ok"), { ids: { ts: message.ts, webhook: path } })
  }

  private postMessage(args: Args, context: OperationContext): Reply {
    const channel = this.channel(args.channel, context)
    if (channel.is_archived) throw new SlackError("is_archived")
    const blocks = checkBlocks(args.blocks)
    const attachments = checkAttachments(args.attachments)
    const messageText = typeof args.text === "string" ? args.text : null
    if (!messageText && !blocks && !attachments) throw new SlackError("no_text")
    if (messageText && messageText.length > 40_000) throw new SlackError("msg_too_long")
    const message = this.record({
      to: [channel.id, `#${channel.name}`],
      source: "api",
      method: "chat.postMessage",
      webhook: null,
      channel: channel.id,
      text: messageText,
      blocks,
      attachments,
      thread_ts: str(args.thread_ts) ?? null,
      ts: this.state.nextTs(this.now()),
      user: this.settings().botUserId,
      ephemeral: false,
      edited: null,
      unfurl_links: flag(args.unfurl_links),
    })
    return reply(
      {
        ok: true,
        channel: channel.id,
        ts: message.ts,
        message: this.messageBody(message),
      },
      { ids: { channel: channel.id, ts: message.ts } },
    )
  }

  private update(args: Args, context: OperationContext): Reply {
    const channel = this.channel(args.channel, context)
    const ts = str(args.ts)
    const message = ts ? this.state.findMessage(channel.id, ts) : undefined
    if (!message) throw new SlackError("message_not_found")
    if (message.source !== "api") throw new SlackError("cant_update_message")
    const blocks = checkBlocks(args.blocks)
    checkAttachments(args.attachments)
    const messageText = typeof args.text === "string" ? args.text : null
    if (!messageText && !blocks && args.blocks === undefined) throw new SlackError("no_text")
    const next: SlackMessage = {
      ...message,
      text: messageText ?? message.text,
      // Omitted blocks are retained, as Slack documents; `[]` clears them.
      blocks:
        Array.isArray(args.blocks) && args.blocks.length === 0 ? null : (blocks ?? message.blocks),
      edited: { user: this.settings().botUserId, ts: this.state.nextTs(this.now()) },
    }
    this.state.outbox.update(message.id, next)
    return reply(
      {
        ok: true,
        channel: channel.id,
        ts: message.ts,
        text: next.text ?? "",
        message: this.messageBody(next),
      },
      { ids: { channel: channel.id, ts: message.ts } },
    )
  }

  private postEphemeral(args: Args, context: OperationContext): Reply {
    const channel = this.channel(args.channel, context)
    const userId = str(args.user)
    const user = userId ? this.state.users.get(userId) : undefined
    if (!user) throw new SlackError("user_not_found")
    const blocks = checkBlocks(args.blocks)
    checkAttachments(args.attachments)
    const messageText = typeof args.text === "string" ? args.text : null
    if (!messageText && !blocks) throw new SlackError("no_text")
    const message = this.record({
      to: [channel.id, `#${channel.name}`, user.id],
      source: "api",
      method: "chat.postEphemeral",
      webhook: null,
      channel: channel.id,
      text: messageText,
      blocks,
      attachments: null,
      thread_ts: str(args.thread_ts) ?? null,
      ts: this.state.nextTs(this.now()),
      user: user.id,
      ephemeral: true,
      edited: null,
      unfurl_links: flag(args.unfurl_links),
    })
    return reply(
      { ok: true, message_ts: message.ts },
      {
        ids: { channel: channel.id, ts: message.ts },
      },
    )
  }

  private permalink(args: Args, context: OperationContext): Reply {
    const channel = this.channel(args.channel, context)
    const ts = str(args.message_ts)
    const message = ts ? this.state.findMessage(channel.id, ts) : undefined
    if (!message) throw new SlackError("message_not_found")
    const base = `https://${this.settings().teamDomain}.slack.com/archives/${channel.id}/p${message.ts.replace(".", "")}`
    const permalink = message.thread_ts
      ? `${base}?thread_ts=${message.thread_ts}&cid=${channel.id}`
      : base
    return reply({ ok: true, channel: channel.id, permalink })
  }

  private react(args: Args, context: OperationContext, mode: "add" | "remove"): Reply {
    const name = str(args.name)?.replace(/:/g, "")
    if (!name) throw new SlackError("invalid_name")
    if (args.channel === undefined && args.timestamp === undefined) {
      throw new SlackError("no_item_specified")
    }
    const channel = this.channel(args.channel, context)
    const ts = str(args.timestamp)
    const message = ts ? this.state.findMessage(channel.id, ts) : undefined
    if (!message) throw new SlackError("message_not_found")
    const bot = this.settings().botUserId
    const reactions = message.reactions.map((r) => ({ ...r, users: [...r.users] }))
    const existing = reactions.find((r) => r.name === name)
    if (mode === "add") {
      if (existing?.users.includes(bot)) throw new SlackError("already_reacted")
      if (existing) {
        existing.users.push(bot)
        existing.count = existing.users.length
      } else reactions.push({ name, users: [bot], count: 1 })
    } else {
      if (!existing?.users.includes(bot)) throw new SlackError("no_reaction")
      existing.users = existing.users.filter((u) => u !== bot)
      existing.count = existing.users.length
    }
    this.state.outbox.update(message.id, {
      ...message,
      reactions: reactions.filter((r) => r.count > 0),
    })
    return reply({ ok: true })
  }

  private reactions(args: Args, context: OperationContext): Reply {
    if (args.channel === undefined && args.timestamp === undefined) {
      throw new SlackError("no_item_specified")
    }
    const channel = this.channel(args.channel, context)
    const ts = str(args.timestamp)
    const message = ts ? this.state.findMessage(channel.id, ts) : undefined
    if (!message) throw new SlackError("message_not_found")
    return reply({
      ok: true,
      type: "message",
      channel: channel.id,
      message: this.messageBody(message),
    })
  }

  private authTest(): Reply {
    const settings = this.settings()
    const bot = this.state.users.get(settings.botUserId)
    return reply({
      ok: true,
      url: `https://${settings.teamDomain}.slack.com/`,
      team: settings.teamName,
      user: bot?.name ?? "mockingbird",
      team_id: settings.teamId,
      user_id: settings.botUserId,
      bot_id: settings.botId,
      is_enterprise_install: false,
    })
  }

  private channelBody(channel: SlackChannel) {
    return {
      id: channel.id,
      name: channel.name,
      is_channel: !channel.is_private,
      is_private: channel.is_private,
      is_archived: channel.is_archived,
      is_member: channel.is_member,
      created: channel.created,
    }
  }

  private join(args: Args, context: OperationContext): Reply {
    const channel = this.channel(args.channel, context)
    if (channel.is_archived) throw new SlackError("is_archived")
    if (channel.is_private) throw new SlackError("method_not_supported_for_channel_type")
    if (channel.is_member) {
      return reply({
        ok: true,
        channel: this.channelBody(channel),
        warning: "already_in_channel",
        response_metadata: { warnings: ["already_in_channel"] },
      })
    }
    const joined = { ...channel, is_member: true }
    this.state.channels.update(channel.id, joined)
    return reply({ ok: true, channel: this.channelBody(joined) })
  }

  private userBody(user: SlackUser) {
    return {
      id: user.id,
      team_id: this.settings().teamId,
      name: user.name,
      real_name: user.real_name,
      deleted: user.deleted,
      is_bot: user.is_bot,
      tz: user.tz,
      profile: {
        real_name: user.real_name,
        display_name: user.name,
        ...(user.email !== null ? { email: user.email } : {}),
      },
    }
  }

  private userInfo(args: Args): Reply {
    const id = str(args.user)
    const user = id ? this.state.users.get(id) : undefined
    if (!user) throw new SlackError("user_not_found")
    return reply({ ok: true, user: this.userBody(user) })
  }

  private lookupByEmail(args: Args): Reply {
    const email = str(args.email)
    if (!email) throw new SlackError("invalid_arguments")
    const user = this.state.findUserByEmail(email)
    if (!user) throw new SlackError("users_not_found")
    return reply({ ok: true, user: this.userBody(user) })
  }

  private fileBody(file: SlackFile) {
    const settings = this.settings()
    const base = `https://files.slack.com/files-pri/${settings.teamId}-${file.id}`
    return {
      ...file,
      url_private: `${base}/${encodeURIComponent(file.name)}`,
      url_private_download: `${base}/download/${encodeURIComponent(file.name)}`,
      permalink: `https://${settings.teamDomain}.slack.com/files/${settings.botUserId}/${file.id}/${encodeURIComponent(file.name)}`,
    }
  }

  private fileInfo(args: Args): Reply {
    const id = str(args.file)
    const file = id ? this.state.files.get(id) : undefined
    if (!file) throw new SlackError("file_not_found")
    return reply({ ok: true, file: this.fileBody(file) })
  }

  /**
   * `apps.connections.open`. The app token must be an `Authorization: Bearer xapp-…` header
   * (Slack rejects a body token). The WebSocket URL is on this same host; the Node server
   * accepts it. `@slack/socket-mode@2.0.4` reconnects by calling this method again — it does
   * not read a URL out of a `disconnect` envelope, and Slack's documented envelope has none.
   */
  private connectionsOpen(context: OperationContext): Response {
    const limited = faultEffect(context.request, "connections_open_429")
    if (limited) {
      const retryAfter = String(typeof limited.retryAfter === "number" ? limited.retryAfter : 1)
      return jsonRes(429, { ok: false, error: "ratelimited" }, { "retry-after": retryAfter })
    }
    const broken = faultEffect(context.request, "connections_open_5xx")
    if (broken) {
      const status = typeof broken.status === "number" ? broken.status : 500
      const code = status === 503 ? "service_unavailable" : "internal_error"
      return jsonRes(status, { ok: false, error: code })
    }
    if (faultEffect(context.request, "connections_open_invalid_auth") !== undefined) {
      return fail("invalid_auth")
    }
    const token = bearerToken(context.request)
    if (!token) return fail("not_authed")
    if (/^xox[abp]-/.test(token)) return fail("not_allowed_token_type")
    if (!APP_TOKEN.test(token)) return fail("invalid_auth")
    const settings = this.settings()
    if (settings.revokedAppTokens.includes(token)) return fail("token_revoked")
    if (settings.appTokens.length > 0 && !settings.appTokens.includes(token)) {
      return fail("invalid_auth")
    }
    const latency = faultEffect(context.request, "socket_hello_latency")
    const helloLatencyMs =
      latency === undefined
        ? 0
        : typeof latency.latencyMs === "number"
          ? latency.latencyMs
          : typeof latency.delayMs === "number"
            ? latency.delayMs
            : 0
    const issued = issueSocketTicket({
      namespace: this.namespaceName,
      appId: settings.appId,
      helloLatencyMs,
      closeAfterHello: faultEffect(context.request, "socket_close_after_hello") !== undefined,
      abnormalClose: faultEffect(context.request, "socket_abnormal_close") !== undefined,
      lifetimeMs: settings.socketLifetimeMs,
    })
    const host = context.request.headers.get("host") ?? context.url.host
    const forwarded = context.request.headers.get("x-forwarded-proto")
    const scheme = forwarded === "https" || context.url.protocol === "https:" ? "wss" : "ws"
    const url = `${scheme}://${host}/link/?ticket=${encodeURIComponent(issued.ticket)}&app_id=${encodeURIComponent(settings.appId)}`
    const contentType = context.request.headers.get("content-type") ?? ""
    const json = contentType.includes("application/json")
    const response = jsonRes(
      200,
      json && !/charset=/i.test(contentType)
        ? {
            ok: true,
            url,
            warning: "missing_charset",
            response_metadata: { warnings: ["missing_charset"] },
          }
        : { ok: true, url },
    )
    return annotateResponse(response, { ids: { app_id: settings.appId } })
  }

  private openView(args: Args): Reply {
    if (!str(args.trigger_id)) throw new SlackError("invalid_arguments")
    const view = args.view
    if (!isRecord(view) || (view.type !== "modal" && view.type !== "home")) {
      throw new SlackError("invalid_arguments", {
        response_metadata: { messages: ["[ERROR] view.type must be modal"] },
      })
    }
    const settings = this.settings()
    const seq = this.state.views.nextSequence()
    const id = `V${opaqueToken(`view:${seq}`, 10).toUpperCase()}`
    const stored = {
      ...view,
      id,
      team_id: settings.teamId,
      state: { values: {} },
      hash: `${Math.floor(this.now() / 1000)}.${opaqueToken(`hash:${seq}`, 8)}`,
      app_id: settings.appId,
      bot_id: settings.botId,
      blocks: Array.isArray(view.blocks) ? view.blocks : [],
    }
    this.state.views.insert(id, stored)
    return reply({ ok: true, view: stored }, { ids: { view: id } })
  }
}

export type { SlackRuntime, SlackRuntimeOptions } from "./runtime.js"
export { createRuntime, SLACK_PRESETS } from "./runtime.js"
