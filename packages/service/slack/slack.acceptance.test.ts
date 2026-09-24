import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, SLACK_PRESETS, type SlackMessage } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type Fetch,
  postSlackWebApiMessage,
  postSlackWebhook,
  postTier1ViaWebApi,
  RETRY_DELAYS_MS,
  releaseConductorPost,
  SlackApiError,
  SlackClient,
  silentLogger,
  tier1Payload,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const HOST = "http://slack.mock"
const API = `${HOST}/api`
const HOOK = `${HOST}/services/T0ACME/B0ALERTS/abcdEFGH1234ijklMNOP5678`
const TOKEN = "xoxb-emr-critical-alerts"

/** A runtime, a `fetch` into it, recorded backoff sleeps and admin helpers. */
const harness = () => {
  const runtime = createRuntime()
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    runtime.fetch(
      new Request(`${HOST}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const outbox = async (query = ""): Promise<SlackMessage[]> =>
    ((await (await admin(`/outbox${query}`)).json()) as { messages: SlackMessage[] }).messages
  return { runtime, fetchImpl, sleeps, sleep, admin, outbox }
}

/**
 * A `fetch` into the runtime whose first attempt meets the `rate_limited` preset and second the
 * `5xx` preset (each preset armed just before its attempt, so the two never stack).
 */
const failingThen429Then5xx = (runtime: ReturnType<typeof createRuntime>): Fetch => {
  let attempt = 0
  return (input, init) => {
    attempt++
    if (attempt === 1) runtime.applyPreset("rate_limited", "default", { count: 1 })
    if (attempt === 2) runtime.applyPreset("5xx", "default", { count: 1 })
    return runtime.fetch(new Request(input, init))
  }
}

describe("S17 acceptance: incoming webhooks through backend postSlackWebhook", () => {
  test("a post answers 200 ok and lands in the outbox under its webhook path", async () => {
    const { fetchImpl, sleep, outbox } = harness()
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*reconcile* failed" } }]
    const result = await postSlackWebhook(
      HOOK,
      { text: "pipeline alert: reconcile failed", blocks },
      silentLogger(),
      "pipeline",
      { fetch: fetchImpl, sleep },
    )
    expect(result).toEqual({ posted: true })
    const [message] = await outbox(
      `?webhook=${encodeURIComponent("/services/T0ACME/B0ALERTS/abcdEFGH1234ijklMNOP5678")}`,
    )
    expect(message?.text).toBe("pipeline alert: reconcile failed")
    expect(message?.blocks).toEqual(blocks)
    expect(message?.ts).toMatch(/^\d{10}\.\d{6}$/)
    expect(message?.thread_ts).toBeNull()
    // The raw response is Slack's: text/plain "ok".
    const raw = await fetchImpl(HOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "again" }),
    })
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-type")).toMatch(/^text\/plain/)
    expect(await raw.text()).toBe("ok")
  })

  test("429 and 5xx are retried at 0, 2 and 8 s; the third attempt lands", async () => {
    const { runtime, sleeps, sleep, outbox } = harness()
    const logger = silentLogger()
    const result = await postSlackWebhook(HOOK, { text: "billing alert" }, logger, "billing", {
      fetch: failingThen429Then5xx(runtime),
      sleep,
    })
    expect(result).toEqual({ posted: true })
    expect([0, ...sleeps]).toEqual([...RETRY_DELAYS_MS])
    expect(logger.lines.filter((l) => l.includes("transient"))).toEqual([
      "warn billing: transient 429 from Slack (attempt 1)",
      "warn billing: transient 500 from Slack (attempt 2)",
    ])
    expect((await outbox()).map((m) => m.text)).toEqual(["billing alert"])
  })

  test("retries run out after three transient failures", async () => {
    const { runtime, fetchImpl, sleeps, sleep, outbox } = harness()
    runtime.applyPreset("service_unavailable", "default", { count: 3 })
    const result = await postSlackWebhook(HOOK, { text: "x" }, silentLogger(), "erx", {
      fetch: fetchImpl,
      sleep,
    })
    expect(result).toEqual({ posted: false, reason: "retries_exhausted" })
    expect(sleeps).toEqual([2_000, 8_000])
    expect(await outbox()).toEqual([])
  })

  test("other 4xx are terminal on the first attempt: no_text, no_service, channel_not_found", async () => {
    const cases: [string, (h: ReturnType<typeof harness>) => Promise<unknown>, string][] = [
      ["no_text", async () => undefined, "slack_4xx_400"],
      [
        "no_service",
        async (h) => h.admin("/hooks", { path: "T0OTHER/B0OTHER/zzzzzzzzzzzz" }),
        "slack_4xx_404",
      ],
      [
        "channel_not_found",
        async (h) => h.runtime.applyPreset("channel_not_found", "default", { count: 1 }),
        "slack_4xx_404",
      ],
    ]
    for (const [name, arrange, reason] of cases) {
      const h = harness()
      await arrange(h)
      const result = await postSlackWebhook(
        HOOK,
        { text: name === "no_text" ? "" : "alert" },
        silentLogger(),
        name,
        { fetch: h.fetchImpl, sleep: h.sleep },
      )
      expect(result).toEqual({ posted: false, reason })
      expect(h.sleeps).toEqual([])
      expect(await h.outbox()).toEqual([])
    }
  })

  test("Slack's real plain-text error bodies for bad payloads", async () => {
    const { fetchImpl } = harness()
    const post = async (body: string, type = "application/json") => {
      const r = await fetchImpl(HOOK, { method: "POST", headers: { "content-type": type }, body })
      return `${r.status} ${await r.text()}`
    }
    expect(await post("{not json")).toBe("400 invalid_payload")
    expect(await post("[1,2]")).toBe("400 invalid_payload")
    expect(await post("{}")).toBe("400 no_text")
    expect(await post(JSON.stringify({ blocks: "nope" }))).toBe("400 invalid_blocks")
    // The legacy form style: payload=<json>.
    expect(
      await post(
        `payload=${encodeURIComponent(JSON.stringify({ text: "form" }))}`,
        "application/x-www-form-urlencoded",
      ),
    ).toBe("200 ok")
  })

  test("registered hooks route to their channel; outbox filters by channel or webhook", async () => {
    const { admin, fetchImpl, sleep, outbox } = harness()
    await admin("/channels", { id: "C0PIPELINE", name: "pipeline-alerts" })
    await admin("/hooks", { path: HOOK, channel: "C0PIPELINE" })
    const other = `${HOST}/services/T0ACME/B0ERX/erxerxerxerxerx`
    await admin("/hooks", { path: other })
    const deps = { fetch: fetchImpl, sleep }
    await postSlackWebhook(HOOK, { text: "pipeline" }, silentLogger(), "a", deps)
    await postSlackWebhook(other, { text: "erx" }, silentLogger(), "b", deps)
    expect((await outbox("?channel=C0PIPELINE")).map((m) => m.text)).toEqual(["pipeline"])
    expect((await outbox("?channel=%23pipeline-alerts")).map((m) => m.text)).toEqual(["pipeline"])
    expect((await outbox(`?webhook=${encodeURIComponent(other)}`)).map((m) => m.text)).toEqual([
      "erx",
    ])
    expect(
      await postSlackWebhook(
        `${HOST}/services/T0X/B0X/unregistered`,
        { text: "x" },
        silentLogger(),
        "c",
        deps,
      ),
    ).toEqual({ posted: false, reason: "slack_4xx_404" })
  })

  test("an unset webhook URL is skipped without a request", async () => {
    const { outbox } = harness()
    const logger = silentLogger()
    expect(await postSlackWebhook(undefined, { text: "x" }, logger)).toEqual({
      posted: false,
      reason: "webhook_not_configured",
    })
    expect(await outbox()).toEqual([])
  })
})

describe("S17 acceptance: EMR chat.postMessage (critical alerts)", () => {
  test("Tier-1 alert posts with blocks and returns the ts; the follow-up threads under it", async () => {
    const { fetchImpl, sleep, outbox } = harness()
    const payload = tier1Payload("Ada Lovelace", "Potassium")
    const posted = await postTier1ViaWebApi(API, payload, TOKEN, "C0URGENT", {
      fetch: fetchImpl,
      sleep,
    })
    expect(posted.posted).toBe(true)
    expect(posted.channel).toBe("C0URGENT")
    const ts = posted.ts as string
    const reply = await postSlackWebApiMessage(
      API,
      { token: TOKEN, channel: "C0URGENT", text: "Assigned to Grace", threadTs: ts },
      fetchImpl,
    )
    expect(reply.ok).toBe(true)
    const thread = await outbox(`?channel=C0URGENT&thread_ts=${ts}`)
    expect(thread.map((m) => m.text)).toEqual(["Assigned to Grace"])
    const [alert] = await outbox("?channel=C0URGENT")
    expect(alert?.ts).toBe(ts)
    expect(alert?.blocks).toEqual(payload.blocks)
    expect(alert?.text).toContain("<!channel>")
  })

  test("the envelope is {ok, ts, channel, message}; errors are {ok:false, error} at HTTP 200", async () => {
    const { fetchImpl } = harness()
    const response = await fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ channel: "#alerts", text: "hello" }),
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, channel: "C0ALERTS", message: { text: "hello" } })
    expect(body.ts).toBe((body.message as { ts: string }).ts)
    const unauthed = await fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: "#alerts", text: "hello" }),
    })
    expect(unauthed.status).toBe(200)
    expect(await unauthed.json()).toEqual({ ok: false, error: "not_authed" })
    expect(
      await postSlackWebApiMessage(API, { token: "garbage", channel: "C1", text: "x" }, fetchImpl),
    ).toEqual({ ok: false, error: "invalid_auth", status: 200 })
  })

  test("channel_not_found is terminal; rate_limited and 5xx are retried", async () => {
    const terminal = harness()
    terminal.runtime.applyPreset("channel_not_found", "default", { count: 1 })
    expect(
      await postTier1ViaWebApi(API, tier1Payload("A", "B"), TOKEN, "C0GONE", {
        fetch: terminal.fetchImpl,
        sleep: terminal.sleep,
      }),
    ).toEqual({ posted: false, reason: "slack_web_api_channel_not_found" })
    expect(terminal.sleeps).toEqual([])

    const transient = harness()
    const result = await postTier1ViaWebApi(API, tier1Payload("A", "B"), TOKEN, "C0URGENT", {
      fetch: failingThen429Then5xx(transient.runtime),
      sleep: transient.sleep,
    })
    expect(result.posted).toBe(true)
    expect(transient.sleeps).toEqual([2_000, 8_000])

    // The raw 429: Slack's own error code and a retry-after header.
    const limited = harness()
    limited.runtime.applyPreset("rate_limited", "default", { count: 1, params: { retryAfter: 7 } })
    const raw = await limited.fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ channel: "C1", text: "x" }),
    })
    expect(raw.status).toBe(429)
    expect(raw.headers.get("retry-after")).toBe("7")
    expect(await raw.json()).toEqual({ ok: false, error: "ratelimited" })
  })

  test("strictChannels turns unknown channels into channel_not_found", async () => {
    const { admin, fetchImpl } = harness()
    await admin("/settings", { strictChannels: true }, "PUT")
    expect(
      await postSlackWebApiMessage(API, { token: TOKEN, channel: "C0NOPE", text: "x" }, fetchImpl),
    ).toEqual({ ok: false, error: "channel_not_found", status: 200 })
    expect(
      (
        await postSlackWebApiMessage(
          API,
          { token: TOKEN, channel: "#general", text: "x" },
          fetchImpl,
        )
      ).ok,
    ).toBe(true)
  })

  test("release-conductor honours retry-after on 429, then posts", async () => {
    const { runtime, fetchImpl, sleeps, sleep, outbox } = harness()
    runtime.applyPreset("rate_limited", "default", { count: 2, params: { retryAfter: 3 } })
    const { ts } = await releaseConductorPost(
      API,
      TOKEN,
      "C0RELEASE",
      "v1.2.3 shipped",
      undefined,
      {
        fetch: fetchImpl,
        sleep,
      },
    )
    expect(sleeps).toEqual([3_000, 3_000])
    expect((await outbox("?channel=C0RELEASE")).map((m) => m.ts)).toEqual([ts])
  })
})

describe("S17 acceptance: request-intake SlackClient (the cheap methods)", () => {
  test("auth, join, post, permalink, reactions, ephemeral, users, files, views", async () => {
    const { fetchImpl, outbox, runtime } = harness()
    const slack = new SlackClient("xoxb-request-intake", API, fetchImpl)
    expect(await slack.authTest()).toEqual({ userId: "U0MOCKBOT", botId: "B0MOCKBOT" })
    expect(await slack.joinChannel("C0ALERTS")).toBe("joined")
    expect(await slack.joinChannel("C0ALERTS")).toBe("already")
    runtime.applyPreset("channel_not_found", "default", { count: 1 })
    expect(await slack.joinChannel("C0ALERTS")).toBe("cannot")

    const { ts, channel } = await slack.postMessage({ channel: "C0ALERTS", text: "New request" })
    expect(channel).toBe("C0ALERTS")
    expect(await slack.permalink("C0ALERTS", ts)).toBe(
      `https://mockingbird.slack.com/archives/C0ALERTS/p${ts.replace(".", "")}`,
    )
    await expect(slack.permalink("C0ALERTS", "1.000000")).rejects.toThrow(
      "Slack chat.getPermalink failed: message_not_found",
    )

    const target = { channel: "C0ALERTS", timestamp: ts }
    expect(await slack.ownReactions(target, "U0MOCKBOT")).toEqual([])
    await slack.addReaction({ ...target, name: "eyes" })
    await slack.addReaction({ ...target, name: "eyes" }) // already_reacted is swallowed
    expect(await slack.ownReactions(target, "U0MOCKBOT")).toEqual(["eyes"])
    await slack.removeReaction({ ...target, name: "eyes" })
    await slack.removeReaction({ ...target, name: "eyes" }) // no_reaction is swallowed
    expect(await slack.ownReactions(target, "U0MOCKBOT")).toEqual([])

    const ephemeral = await slack.postEphemeral({
      channel: "C0ALERTS",
      user: "U0ADA",
      text: "psst",
    })
    expect(ephemeral.message_ts).toMatch(/^\d+\.\d{6}$/)
    await expect(
      slack.postEphemeral({ channel: "C0ALERTS", user: "U0NOBODY", text: "x" }),
    ).rejects.toThrow("user_not_found")

    expect(await slack.lookupByEmail("ADA@example.com")).toBe("U0ADA")
    expect(await slack.lookupByEmail("nobody@example.com")).toBeUndefined()
    expect(await slack.userInfo("U0ADA")).toEqual({
      email: "ada@example.com",
      name: "Ada Lovelace",
    })

    const file = await slack.fileInfo("F0REPORT")
    expect(file).toMatchObject({ name: "lab-report.pdf", mimetype: "application/pdf" })
    // The client refuses to send the bot token to a non-Slack host, so the URL stays Slack's.
    expect(new URL(file.urlPrivateDownload as string).hostname).toBe("files.slack.com")
    await expect(slack.fileInfo("F0MISSING")).rejects.toThrow("file_not_found")

    const view = await slack.openView("12345.98765.abcd", {
      type: "modal",
      callback_id: "intake",
      title: { type: "plain_text", text: "New request" },
      blocks: [],
    })
    expect(view.view.id).toMatch(/^V/)
    await expect(slack.openView("12345.98765.abcd", { type: "bogus" })).rejects.toThrow(
      "invalid_arguments",
    )

    const texts = (await outbox("?channel=C0ALERTS")).map((m) => [m.text, m.ephemeral])
    expect(texts).toEqual([
      ["New request", false],
      ["psst", true],
    ])
  })

  test("a 429 surfaces as SlackApiError ratelimited with retry-after in ms", async () => {
    const { runtime, fetchImpl } = harness()
    runtime.applyPreset("rate_limited", "default", { count: 1, params: { retryAfter: 2 } })
    const slack = new SlackClient("xoxb-request-intake", API, fetchImpl)
    const error = await slack.postMessage({ channel: "C0ALERTS", text: "x" }).catch((e) => e)
    expect(error).toBeInstanceOf(SlackApiError)
    expect((error as SlackApiError).code).toBe("ratelimited")
    expect((error as SlackApiError).retryAfterMs).toBe(2_000)
  })
})

describe("S17 contract", () => {
  test("form-encoded and JSON Web API bodies are both accepted (blocks JSON-encoded in forms)", async () => {
    const { fetchImpl, outbox } = harness()
    const blocks = [{ type: "divider" }]
    const form = new URLSearchParams({
      channel: "C0FORM",
      text: "form post",
      blocks: JSON.stringify(blocks),
    })
    const response = await fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${TOKEN}`,
      },
      body: form.toString(),
    })
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
    const legacy = await fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN, channel: "C0FORM", text: "legacy" }).toString(),
    })
    expect(((await legacy.json()) as { ok: boolean }).ok).toBe(true)
    const broken = await fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${TOKEN}`,
      },
      body: "channel=C0FORM&blocks=%5Bnot-json",
    })
    expect(((await broken.json()) as { error: string }).error).toBe("invalid_blocks_format")
    // JSON without a charset still posts, with Slack's missing_charset warning.
    const bare = await fetchImpl(`${API}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ channel: "C0FORM", text: "json" }),
    })
    expect(await bare.json()).toMatchObject({ ok: true, warning: "missing_charset" })
    expect((await outbox("?channel=C0FORM")).map((m) => [m.text, m.blocks])).toEqual([
      ["form post", blocks],
      ["legacy", null],
      ["json", null],
    ])
  })

  test("chat.update edits the outbox message; webhook posts cannot be updated", async () => {
    const { fetchImpl, outbox } = harness()
    const call = async (method: string, body: Record<string, unknown>) =>
      (await (
        await fetchImpl(`${API}/${method}`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>
    const posted = await call("chat.postMessage", { channel: "C0UPD", text: "v1" })
    const updated = await call("chat.update", { channel: "C0UPD", ts: posted.ts, text: "v2" })
    expect(updated).toMatchObject({ ok: true, ts: posted.ts, text: "v2" })
    const [message] = await outbox("?channel=C0UPD")
    expect(message?.text).toBe("v2")
    expect(message?.edited?.user).toBe("U0MOCKBOT")
    expect(await call("chat.update", { channel: "C0UPD", ts: "1.000000", text: "x" })).toEqual({
      ok: false,
      error: "message_not_found",
    })
  })

  test("namespaces by bot token, by webhook path, by /ns/ prefix and by header isolate outboxes", async () => {
    const { runtime, fetchImpl, admin, sleep } = harness()
    await admin(
      "/credentials",
      { credentials: { "xoxb-worker-a": "a", "T0W/B0W/worker-b-hook": "b" } },
      "PUT",
    )
    await postSlackWebApiMessage(
      API,
      { token: "xoxb-worker-a", channel: "C1", text: "from a" },
      fetchImpl,
    )
    await postSlackWebhook(
      `${HOST}/services/T0W/B0W/worker-b-hook`,
      { text: "from b" },
      silentLogger(),
      "b",
      {
        fetch: fetchImpl,
        sleep,
      },
    )
    await postSlackWebhook(
      `${HOST}/ns/c/services/T0/B0/xyz`,
      { text: "from c" },
      silentLogger(),
      "c",
      {
        fetch: fetchImpl,
        sleep,
      },
    )
    const texts = (namespace: string) =>
      runtime
        .instance(namespace)
        .messages()
        .map((m) => m.text)
    expect(texts("a")).toEqual(["from a"])
    expect(texts("b")).toEqual(["from b"])
    expect(texts("c")).toEqual(["from c"])
    expect(texts("default")).toEqual([])
    const viaHeader = await runtime.fetch(
      new Request(`${HOST}/__admin/outbox`, { headers: { "x-mockingbird-namespace": "a" } }),
    )
    expect(((await viaHeader.json()) as { messages: unknown[] }).messages).toHaveLength(1)
  })

  test("the journal records metadata only, never message text", async () => {
    const { fetchImpl, sleep, admin } = harness()
    await postSlackWebhook(
      HOOK,
      { text: "PHI: Ada Lovelace, potassium 7.1" },
      silentLogger(),
      "x",
      {
        fetch: fetchImpl,
        sleep,
      },
    )
    await postSlackWebApiMessage(API, { token: TOKEN, channel: "C1", text: "PHI again" }, fetchImpl)
    const journal = await (await admin("/requests")).json()
    const serialized = JSON.stringify(journal)
    expect(serialized).not.toContain("Lovelace")
    expect(serialized).not.toContain("PHI")
    expect(serialized).toContain("ChatPostMessage")
  })

  test("reset clears the outbox and re-seeds the workspace", async () => {
    const { runtime, fetchImpl, outbox } = harness()
    await postSlackWebApiMessage(API, { token: TOKEN, channel: "C1", text: "x" }, fetchImpl)
    await runtime.fetch(new Request(`${HOST}/__admin/reset`, { method: "POST" }))
    expect(await outbox()).toEqual([])
    const slack = new SlackClient(TOKEN, API, fetchImpl)
    expect(await slack.lookupByEmail("ada@example.com")).toBe("U0ADA")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(SLACK_PRESETS)).toEqual(
      expect.arrayContaining(["rate_limited", "5xx", "channel_not_found"]),
    )
  })

  test("any webhook text and blocks round-trip through the outbox", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.array(fc.constantFrom("section", "divider", "header", "context"), { maxLength: 5 }),
        async (text, types) => {
          const { fetchImpl, sleep, outbox } = harness()
          const blocks = types.map((type) => ({ type }))
          const result = await postSlackWebhook(
            HOOK,
            { text, ...(blocks.length > 0 ? { blocks } : {}) },
            silentLogger(),
            "p",
            { fetch: fetchImpl, sleep },
          )
          expect(result.posted).toBe(true)
          const [message] = await outbox()
          expect(message?.text).toBe(text)
          expect(message?.blocks).toEqual(blocks.length > 0 ? blocks : null)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  })
})

describe("served over HTTP", () => {
  test("webhooks and the Web API work against the node server with plain fetch", async () => {
    const server = await createServer()
    try {
      const result = await postSlackWebhook(
        `${server.url}/services/T0HTTP/B0HTTP/httphttphttp`,
        { text: "over the wire" },
        silentLogger(),
      )
      expect(result).toEqual({ posted: true })
      const posted = await postSlackWebApiMessage(`${server.url}/api`, {
        token: TOKEN,
        channel: "C0HTTP",
        text: "api over the wire",
      })
      expect(posted.ok).toBe(true)
      const outbox = (await (await fetch(`${server.url}/__admin/outbox`)).json()) as {
        messages: SlackMessage[]
      }
      expect(outbox.messages.map((m) => m.text)).toEqual(["over the wire", "api over the wire"])
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^slack@/)
    } finally {
      await server.close()
    }
  })
})
