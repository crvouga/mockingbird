import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ErrorCode, WebClient } from "@slack/web-api"
import type { SlackMessage } from "./src/index.js"
import { createServer, type SlackServer } from "./src/server.js"

/**
 * The official `@slack/web-api` (7.9.3, the version Bolt pins in our lockfile) pointed at the
 * served mock through `slackApiUrl`. The SDK posts form-encoded bodies with JSON-encoded
 * `blocks`/`view`, so this also proves the form path the raw-fetch consumers never take.
 */
let server: SlackServer
let client: WebClient

beforeAll(async () => {
  server = await createServer()
  client = new WebClient("xoxb-sdk-token", {
    slackApiUrl: `${server.url}/api/`,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  })
})

afterAll(async () => {
  await server.close()
})

const outbox = async (query = "") =>
  (
    (await (await fetch(`${server.url}/__admin/outbox${query}`)).json()) as {
      messages: SlackMessage[]
    }
  ).messages

describe("@slack/web-api drop-in", () => {
  test("chat.postMessage, chat.update, reactions, permalink and the outbox", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*deploy* done" } }]
    const posted = await client.chat.postMessage({ channel: "C0SDK", text: "deploy done", blocks })
    expect(posted.ok).toBe(true)
    expect(posted.channel).toBe("C0SDK")
    const ts = posted.ts as string
    expect(posted.message?.text).toBe("deploy done")

    const reply = await client.chat.postMessage({
      channel: "C0SDK",
      text: "details",
      thread_ts: ts,
    })
    expect(reply.message?.thread_ts).toBe(ts)

    const updated = await client.chat.update({ channel: "C0SDK", ts, text: "deploy done (edited)" })
    expect(updated.text).toBe("deploy done (edited)")

    await client.reactions.add({ channel: "C0SDK", timestamp: ts, name: "white_check_mark" })
    const reactions = await client.reactions.get({ channel: "C0SDK", timestamp: ts, full: true })
    expect(
      (reactions.message as { reactions?: { name: string; count: number }[] }).reactions,
    ).toEqual([{ name: "white_check_mark", users: ["U0MOCKBOT"], count: 1 }] as never)
    await client.reactions.remove({ channel: "C0SDK", timestamp: ts, name: "white_check_mark" })

    const link = await client.chat.getPermalink({ channel: "C0SDK", message_ts: ts })
    expect(link.permalink).toContain(`/archives/C0SDK/p${ts.replace(".", "")}`)

    const messages = await outbox("?channel=C0SDK")
    expect(messages.map((m) => [m.text, m.thread_ts])).toEqual([
      ["deploy done (edited)", null],
      ["details", ts],
    ])
    // chat.update without blocks keeps the original blocks.
    expect(messages[0]?.blocks).toEqual(blocks)
  })

  test("auth.test, conversations.join, users, files, ephemeral and views.open", async () => {
    const auth = await client.auth.test()
    expect(auth).toMatchObject({ ok: true, user_id: "U0MOCKBOT", bot_id: "B0MOCKBOT" })
    const joined = await client.conversations.join({ channel: "C0ALERTS" })
    expect(joined.channel?.is_member).toBe(true)
    const again = await client.conversations.join({ channel: "C0ALERTS" })
    expect(again.warning).toBe("already_in_channel")

    const byEmail = await client.users.lookupByEmail({ email: "ada@example.com" })
    expect(byEmail.user?.id).toBe("U0ADA")
    const info = await client.users.info({ user: "U0ADA" })
    expect(info.user?.profile?.email).toBe("ada@example.com")

    const file = await client.files.info({ file: "F0REPORT" })
    expect(file.file?.url_private_download).toMatch(/^https:\/\/files\.slack\.com\//)

    const ephemeral = await client.chat.postEphemeral({
      channel: "C0ALERTS",
      user: "U0ADA",
      text: "only you",
    })
    expect(ephemeral.message_ts).toMatch(/^\d+\.\d{6}$/)

    const view = await client.views.open({
      trigger_id: "12345.98765.abcd",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Request" },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hi" } }],
      },
    })
    expect(view.view?.id).toMatch(/^V/)
  })

  test("platform errors surface as the SDK's own error codes", async () => {
    const missing = await client.users
      .lookupByEmail({ email: "nobody@example.com" })
      .catch((e) => e)
    expect(missing.code).toBe(ErrorCode.PlatformError)
    expect(missing.data.error).toBe("users_not_found")

    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "channel_not_found", count: 1 }),
    })
    const gone = await client.chat.postMessage({ channel: "C0GONE", text: "x" }).catch((e) => e)
    expect(gone.data.error).toBe("channel_not_found")
  })

  test("rate_limited is the SDK's rate-limited error with retryAfter; 5xx is an HTTP error", async () => {
    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "rate_limited", count: 1, params: { retryAfter: 4 } }),
    })
    const limited = await client.chat.postMessage({ channel: "C0SDK", text: "x" }).catch((e) => e)
    expect(limited.code).toBe(ErrorCode.RateLimitedError)
    expect(limited.retryAfter).toBe(4)

    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "5xx", count: 1 }),
    })
    const broken = await client.chat.postMessage({ channel: "C0SDK", text: "x" }).catch((e) => e)
    expect(broken.code).toBe(ErrorCode.HTTPError)
    expect(broken.statusCode).toBe(500)
  })
})
