/**
 * Ports of our Slack clients, faithful to the wire and to the status interpretation:
 *
 * - backend `postSlackWebhook` (`apps/backend/src/modules/queues/slack-webhook.ts`): only 200
 *   counts, 429/5xx retry at 0/2/8 s, other 4xx are terminal. The EMR critical-alert webhook
 *   path (`slack-alerter.ts` `postTier1CriticalAlert`) is the same loop.
 * - EMR `postSlackWebApiMessage` (`critical-alerts/slack-web-api.ts`) and the Tier-1 Web API
 *   retry loop (`slack-alerter.ts` `postViaWebApi`), plus the threaded follow-up.
 * - request-intake `SlackClient` (`apps/request-intake/src/slack/client.ts`).
 * - release-conductor `makeSlackClient` (`tooling/release-conductor/src/clients/slack.ts`).
 *
 * The originals call `https://slack.com/api/…` and `setTimeout` directly; here the base URL,
 * `fetch` and `sleep` are injected so the acceptance tests can drive the mock without waiting
 * out the real backoff (the requested delays are recorded instead).
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>
export type Sleep = (ms: number) => Promise<void>

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export type SlackWebhookLogger = {
  log(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const silentLogger = (): SlackWebhookLogger & { lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    log: (m) => void lines.push(`log ${m}`),
    warn: (m) => void lines.push(`warn ${m}`),
    error: (m) => void lines.push(`error ${m}`),
  }
}

export type SlackWebhookBody = { text: string; blocks?: unknown[] }

// Mirrors the critical-alerts slack-alerter pattern: 5xx/429 retry, 4xx terminal.
export const RETRY_DELAYS_MS = [0, 2_000, 8_000] as const
const REQUEST_TIMEOUT_MS = 5_000

/** Backend `postSlackWebhook`: never throws; `{posted}` plus a reason. */
export async function postSlackWebhook(
  webhookUrl: string | undefined,
  body: SlackWebhookBody,
  logger: SlackWebhookLogger,
  context = "slack-webhook",
  deps: { fetch: Fetch; sleep: Sleep } = { fetch: (i, n) => fetch(i, n), sleep: realSleep },
): Promise<{ posted: boolean; reason?: string }> {
  if (!webhookUrl) {
    logger.warn(`${context}: Slack webhook URL unset — skipping alert`)
    return { posted: false, reason: "webhook_not_configured" }
  }
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt] as number
    if (delay > 0) await deps.sleep(delay)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      let response: Response
      try {
        response = await deps.fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (response.status === 200) return { posted: true }
      // 4xx (except 429) is terminal — misconfigured webhook / invalid payload.
      if (response.status !== 429 && response.status < 500) {
        logger.error(`${context}: terminal ${response.status} from Slack — alert not delivered`)
        return { posted: false, reason: `slack_4xx_${response.status}` }
      }
      logger.warn(`${context}: transient ${response.status} from Slack (attempt ${attempt + 1})`)
    } catch (err: unknown) {
      logger.warn(`${context}: network/timeout error (attempt ${attempt + 1}): ${String(err)}`)
    }
  }
  logger.error(`${context}: retries exhausted — alert not delivered`)
  return { posted: false, reason: "retries_exhausted" }
}

export type SlackWebApiPostInput = {
  token: string
  channel: string
  text: string
  blocks?: readonly unknown[]
  threadTs?: string
  timeoutMs?: number
}

export type SlackWebApiPostResult = { ok: boolean; ts?: string; error?: string; status?: number }

/** EMR `postSlackWebApiMessage`: raw fetch to `chat.postMessage`, never throws. */
export async function postSlackWebApiMessage(
  apiBase: string,
  input: SlackWebApiPostInput,
  fetchImpl: Fetch = (i, n) => fetch(i, n),
): Promise<SlackWebApiPostResult> {
  const body: Record<string, unknown> = { channel: input.channel, text: input.text }
  if (input.blocks) body.blocks = input.blocks
  if (input.threadTs) body.thread_ts = input.threadTs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000)
  try {
    const response = await fetchImpl(`${apiBase}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (response.status === 429) return { ok: false, error: "rate_limited", status: 429 }
    if (response.status >= 500) {
      return { ok: false, error: `http_${response.status}`, status: response.status }
    }
    // Slack returns HTTP 200 with a JSON envelope { ok, ts?, error? } even for logical failures.
    const data = (await response.json()) as { ok?: boolean; ts?: string; error?: string } | null
    if (data?.ok !== true) {
      return { ok: false, error: data?.error ?? "unknown_error", status: response.status }
    }
    return { ok: true, ts: data.ts as string, status: response.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" }
  } finally {
    clearTimeout(timer)
  }
}

const RETRYABLE_WEB_API_ERRORS: ReadonlySet<string> = new Set([
  "rate_limited",
  "network_error",
  "AbortError",
])

export type Tier1SlackResult = { posted: boolean; reason?: string; ts?: string; channel?: string }

/** EMR `postViaWebApi`: the Tier-1 critical alert through the Web API, with its retry rules. */
export async function postTier1ViaWebApi(
  apiBase: string,
  payload: { text: string; blocks: unknown[] },
  token: string,
  channel: string,
  deps: { fetch?: Fetch; sleep: Sleep; delays?: readonly number[] },
): Promise<Tier1SlackResult> {
  const delays = deps.delays ?? RETRY_DELAYS_MS
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const delay = delays[attempt] as number
    if (delay > 0) await deps.sleep(delay)
    const result = await postSlackWebApiMessage(
      apiBase,
      { token, channel, text: payload.text, blocks: payload.blocks, timeoutMs: 5_000 },
      deps.fetch,
    )
    if (result.ok) return { posted: true, ...(result.ts ? { ts: result.ts } : {}), channel }
    const retryable =
      (result.status !== undefined && result.status >= 500) ||
      (result.error !== undefined && RETRYABLE_WEB_API_ERRORS.has(result.error))
    if (!retryable) return { posted: false, reason: `slack_web_api_${result.error ?? "unknown"}` }
  }
  return { posted: false, reason: "retries_exhausted" }
}

/** EMR Tier-1 payload: plain-text fallback plus Block Kit, with a channel-wide mention. */
export const tier1Payload = (member: string, biomarker: string) => ({
  text: `<!channel> Tier 1 critical biomarker for ${member}: ${biomarker}`,
  blocks: [
    { type: "header", text: { type: "plain_text", text: "Tier 1 critical biomarker" } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `<!channel>\n*Member:* ${member}\n• *${biomarker}* — Tier 1` },
    },
  ],
})

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export type ReactionTarget = { channel: string; timestamp: string }

/**
 * request-intake `SlackClient`: throws `SlackApiError` carrying
 * Slack's error code; a 429 becomes `ratelimited` with `retry-after` in ms.
 */
export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly apiBase: string,
    private readonly fetchImpl: Fetch = (i, n) => fetch(i, n),
  ) {}

  private async send<T = Record<string, unknown>>(
    method: string,
    init: { method?: "POST"; headers?: Record<string, string>; body?: string; search?: string },
  ): Promise<T> {
    const { search = "", headers, ...rest } = init
    const res = await this.fetchImpl(`${this.apiBase}/${method}${search}`, {
      ...rest,
      headers: { ...headers, authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"))
      throw new SlackApiError(
        `Slack ${method} failed: ratelimited`,
        "ratelimited",
        429,
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
      )
    }
    const text = await res.text()
    type Envelope = { ok?: boolean; error?: string; response_metadata?: { messages?: string[] } }
    let data: (Envelope & T) | null
    try {
      data = JSON.parse(text) as (Envelope & T) | null
    } catch {
      throw new Error(`Slack ${method} invalid response (${res.status})`)
    }
    // biome-ignore lint/complexity/useOptionalChain: kept verbatim from request-intake
    if (!data || data.ok !== true) {
      const detail = data?.response_metadata?.messages?.join("; ")
      throw new SlackApiError(
        `Slack ${method} failed: ${data?.error ?? res.status}${detail ? ` (${detail})` : ""}`,
        data?.error ?? String(res.status),
        res.status,
      )
    }
    return data
  }

  private call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>) {
    return this.send<T>(method, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    })
  }

  openView(triggerId: string, view: Record<string, unknown>) {
    return this.call<{ view: { id: string } }>("views.open", { trigger_id: triggerId, view })
  }

  postMessage(input: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }) {
    return this.call<{ ts: string; channel: string }>("chat.postMessage", input)
  }

  postEphemeral(input: { channel: string; user: string; text: string }) {
    return this.call<{ message_ts: string }>("chat.postEphemeral", input)
  }

  /** The reaction names `userId` left on a message (zod: `reactions` defaults to `[]`). */
  async ownReactions(target: ReactionTarget, userId: string): Promise<string[]> {
    const data = await this.send<{
      message?: { reactions?: { name: string; users: string[] }[] }
    }>("reactions.get", {
      search: `?${new URLSearchParams({ ...target, full: "true" })}`,
    })
    if (!data.message) throw new Error("Slack reactions.get returned an invalid message")
    return (data.message.reactions ?? [])
      .filter((reaction) => reaction.users.includes(userId))
      .map((reaction) => reaction.name)
  }

  async addReaction(input: ReactionTarget & { name: string }): Promise<void> {
    try {
      await this.call("reactions.add", input)
    } catch (error) {
      if (!(error instanceof SlackApiError) || error.code !== "already_reacted") throw error
    }
  }

  async removeReaction(input: ReactionTarget & { name: string }): Promise<void> {
    try {
      await this.call("reactions.remove", input)
    } catch (error) {
      if (!(error instanceof SlackApiError) || error.code !== "no_reaction") throw error
    }
  }

  async authTest(): Promise<{ userId: string; botId: string }> {
    const data = await this.call<{ user_id?: string; bot_id?: string }>("auth.test", {})
    if (!data.user_id || !data.bot_id) throw new Error("Slack auth.test returned no identity")
    return { userId: data.user_id, botId: data.bot_id }
  }

  async joinChannel(channel: string): Promise<"joined" | "already" | "cannot"> {
    try {
      const data = await this.call<{ warning?: string }>("conversations.join", { channel })
      return data.warning === "already_in_channel" ? "already" : "joined"
    } catch {
      return "cannot"
    }
  }

  async fileInfo(fileId: string) {
    const data = await this.send<{
      file?: { url_private_download?: string; name?: string; mimetype?: string; size?: number }
    }>("files.info", { search: `?file=${encodeURIComponent(fileId)}` })
    return {
      urlPrivateDownload: data.file?.url_private_download,
      name: data.file?.name,
      mimetype: data.file?.mimetype,
      size: data.file?.size,
    }
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const data = await this.send<{ permalink?: string }>("chat.getPermalink", {
      search: `?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`,
    })
    if (!data.permalink) throw new Error("Slack chat.getPermalink returned no permalink")
    return data.permalink
  }

  async lookupByEmail(email: string): Promise<string | undefined> {
    try {
      const data = await this.send<{ user?: { id?: string } }>("users.lookupByEmail", {
        search: `?email=${encodeURIComponent(email)}`,
      })
      return data.user?.id
    } catch {
      return undefined
    }
  }

  async userInfo(userId: string): Promise<{ email: string | undefined; name: string | undefined }> {
    const data = await this.send<{ user?: { profile?: { email?: string; real_name?: string } } }>(
      "users.info",
      { search: `?user=${encodeURIComponent(userId)}` },
    )
    return { email: data.user?.profile?.email, name: data.user?.profile?.real_name }
  }
}

/** release-conductor `makeSlackClient().post`: honours `retry-after` on 429, 4 attempts. */
export const releaseConductorPost = async (
  apiBase: string,
  token: string,
  channel: string,
  text: string,
  opts: { threadTs?: string; blocks?: unknown[] } | undefined,
  deps: { fetch?: Fetch; sleep: Sleep },
): Promise<{ ts: string }> => {
  const fetchImpl = deps.fetch ?? ((i: string, n?: RequestInit) => fetch(i, n))
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetchImpl(`${apiBase}/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel,
        text,
        ...(opts?.threadTs === undefined ? {} : { thread_ts: opts.threadTs }),
        ...(opts?.blocks === undefined ? {} : { blocks: opts.blocks }),
      }),
    })
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"))
      await deps.sleep(
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : attempt) * 1000,
      )
      continue
    }
    const body = (await res.json()) as Record<string, unknown>
    if (body.ok !== true) {
      throw new Error(`slack chat.postMessage failed: ${String(body.error ?? res.status)}`)
    }
    return { ts: String(body.ts) }
  }
  throw new Error("slack chat.postMessage rate limited")
}
