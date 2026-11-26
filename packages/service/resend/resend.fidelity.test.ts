/**
 * Send fidelity: outbox shape, idempotency, a response lost after acceptance,
 * and what resend@4.8.0 and resend@2.1.0 actually do with that socket.
 */
import { describe, expect, test } from "bun:test"
import net from "node:net"
import { createRuntime, type ResendRuntimeOptions } from "./src/index.js"
import { createServer } from "./src/server.js"

const API = "http://resend.mock"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
const UNABLE = "Unable to fetch data. The request could not be resolved."

const harness = (options: ResendRuntimeOptions = {}) => {
  const logs: Record<string, unknown>[] = []
  const runtime = createRuntime({
    ...options,
    onLog: (entry) => {
      logs.push({ ...entry })
      options.onLog?.(entry)
    },
  })
  const call = (
    path: string,
    init: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
  ) =>
    runtime.fetch(
      new Request(`${API}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${init.key ?? "re_test"}`,
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  const send = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    key = "re_test",
  ) => call("/emails", { body, headers, key })
  return { runtime, call, send, logs }
}

const email = (overrides: Record<string, unknown> = {}) => ({
  from: "Acme <no-reply@acme.example>",
  to: ["jane@example.com"],
  subject: "Hello",
  html: "<p>Hello</p>",
  ...overrides,
})

const rawPost = (port: number, host: string, request: string) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (value: Buffer) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const socket = net.connect({ host, port }, () => {
      socket.write(request)
    })
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") return
      fail(error)
    })
    socket.setTimeout(2_000, () => {
      socket.destroy()
      fail(new Error("socket timed out"))
    })
    socket.on("close", () => finish(Buffer.concat(chunks)))
  })

const httpSend = (hostHeader: string, key: string) => {
  const payload = JSON.stringify(email())
  return (
    `POST /emails HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    `Authorization: Bearer re_test\r\n` +
    `Content-Type: application/json\r\n` +
    `Idempotency-Key: ${key}\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    `Connection: close\r\n\r\n` +
    payload
  )
}

type SdkReport = {
  sdk: string
  mode: string
  hosts: string[]
  leaked: boolean
  unhandled: boolean
  send?: {
    settled: string
    data: { id?: string } | null
    error: { name?: string; message?: string; statusCode?: number } | null
  }
  validation?: {
    settled: string
    data: unknown
    error: { name?: string; statusCode?: number } | null
  }
  rateLimit?: { settled: string; error: { name?: string; statusCode?: number } | null }
  internal?: { settled: string; error: { name?: string; statusCode?: number } | null }
  nonJson?: { settled: string; name?: string; error?: { name?: string; message?: string } | null }
  networkDrop?: {
    settled: string
    name?: string
    data?: { id?: string } | null
    error?: { name?: string; message?: string } | null
  }
  acceptedDrop?: {
    settled: string
    name?: string
    data?: { id?: string } | null
    error?: { name?: string; message?: string } | null
  }
  retry?: { settled: string; name?: string; data: { id?: string } | null; error: unknown }
  outboxBefore?: number
  outboxAfter?: number
  outboxIds?: string[]
  outcomes?: { accepted: number; lost: number; replayed: number }
}

const runSdk = async (sdk: "2" | "4", mode: "base" | "faults", namespace: string) => {
  const server = await createServer()
  try {
    const proc = Bun.spawn(["bun", "test/sdk-compat.ts"], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        MOCK_URL: server.url,
        RESEND_BASE_URL: server.url,
        SDK: sdk,
        MODE: mode,
        NAMESPACE: namespace,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`sdk-compat ${sdk} ${mode} exit ${code}: ${stderr}\n${stdout}`)
    return JSON.parse(stdout) as SdkReport
  } finally {
    await server.close()
  }
}

describe("sent email fidelity", () => {
  test("a valid send is 200 with one outbox email", async () => {
    const { runtime, send } = harness()
    const response = await send(email())
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: string }
    expect(body.id).toMatch(UUID)
    expect(runtime.instance("default").sent()).toEqual([
      expect.objectContaining({
        id: body.id,
        from: "Acme <no-reply@acme.example>",
        to: ["jane@example.com"],
        toHeader: ["jane@example.com"],
        subject: "Hello",
        html: "<p>Hello</p>",
      }),
    ])
  })

  test("text, reply_to, repeated tags, and headers round-trip; links stay in order", async () => {
    const html =
      '<p>Hello <a href="https://app.example.test/a?x=1&amp;y=2">A</a> <a href="/b">B</a></p>'
    const headers = {
      "List-Unsubscribe": "<https://app.example.test/unsub>",
      "X-Entity-Ref-ID": "abc",
    }
    const tags = [
      { name: "category", value: "welcome" },
      { name: "category", value: "welcome" },
    ]
    const { runtime, call, send } = harness()
    const sent = (await (
      await send(
        email({
          text: "Hello there",
          html,
          reply_to: "care@acme.example",
          tags,
          headers,
        }),
      )
    ).json()) as { id: string }
    const got = (await (await call(`/emails/${sent.id}`)).json()) as {
      text: string
      html: string
      reply_to: string[]
      tags: { name: string; value: string }[]
      headers: Record<string, string>
    }
    expect(got.text).toBe("Hello there")
    expect(got.html).toBe(html)
    expect(got.reply_to).toEqual(["care@acme.example"])
    expect(got.tags).toEqual(tags)
    expect(got.headers).toEqual(headers)
    const stored = runtime.instance("default").sent()[0]
    expect(stored?.html).toBe(html)
    expect(stored?.headers).toEqual(headers)
    expect(stored?.tags).toEqual(tags)
    const links = (
      (await (await call(`/__admin/outbox/${sent.id}/links`)).json()) as { links: string[] }
    ).links
    expect(links).toEqual(["https://app.example.test/a?x=1&y=2", "/b"])
  })

  test("to keeps form and order; the outbox matches the bare address", async () => {
    const { runtime, call, send } = harness()
    const first = (await (await send(email({ to: "Ada <ADA@example.com>" }))).json()) as {
      id: string
    }
    expect(((await (await call(`/emails/${first.id}`)).json()) as { to: string[] }).to).toEqual([
      "Ada <ADA@example.com>",
    ])
    const second = (await (
      await send(email({ to: ["Cara <cara@example.com>", "Bob <bob@example.com>"] }))
    ).json()) as { id: string }
    expect(((await (await call(`/emails/${second.id}`)).json()) as { to: string[] }).to).toEqual([
      "Cara <cara@example.com>",
      "Bob <bob@example.com>",
    ])
    const listed = (
      (await (await call("/__admin/outbox?to=ada@example.com")).json()) as {
        messages: { id: string; to: string[] }[]
      }
    ).messages
    expect(listed.map((message) => message.id)).toEqual([first.id])
    expect(runtime.instance("default").sent()[0]?.to).toEqual(["ada@example.com"])
  })
})

describe("idempotency", () => {
  test("the same key and payload replays the first body and one email", async () => {
    const { runtime, send } = harness()
    const payload = email()
    const headers = { "Idempotency-Key": "order-42" }
    const first = await send(payload, headers)
    const firstText = await first.text()
    const second = await send(payload, headers)
    expect(await second.text()).toBe(firstText)
    expect(second.headers.get("idempotent-replayed")).toBe("true")
    expect(runtime.instance("default").sent()).toHaveLength(1)
  })

  test("the same key with a different payload is 409 and stores nothing new", async () => {
    const { runtime, send } = harness()
    const key = { "Idempotency-Key": "order-42" }
    expect((await send(email(), key)).status).toBe(200)
    const changed = await send(
      email({
        to: ["other@example.com"],
        subject: "Other",
        html: "<p>Other</p>",
        tags: [{ name: "category", value: "other" }],
        headers: { "X-Entity-Ref-ID": "other" },
        attachments: [{ filename: "a.txt", content: "aGVsbG8=" }],
      }),
      key,
    )
    expect(changed.status).toBe(409)
    expect(((await changed.json()) as { name: string }).name).toBe("invalid_idempotent_request")
    expect(runtime.instance("default").sent()).toHaveLength(1)
  })

  test("two in-flight sends with one key: one 200 and one 409", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { runtime, send } = harness({
      forwardToInbox: {
        url: "http://inbox.local",
        fetch: async () => {
          await gate
          return new Response(null, { status: 201 })
        },
      },
    })
    const headers = { "Idempotency-Key": "welcome-1" }
    const first = send(email(), headers)
    await Bun.sleep(10)
    const second = await send(email(), headers)
    expect(second.status).toBe(409)
    expect(((await second.json()) as { name: string }).name).toBe("concurrent_idempotent_requests")
    release()
    expect((await first).status).toBe(200)
    expect(runtime.instance("default").sent()).toHaveLength(1)
  })

  test("key length, and a 422 does not reserve the key", async () => {
    const { runtime, send } = harness()
    const empty = await send(email(), { "Idempotency-Key": "" })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { name: string }).name).toBe("invalid_idempotency_key")
    const tooLong = await send(email(), { "Idempotency-Key": "k".repeat(257) })
    expect(tooLong.status).toBe(400)
    expect(((await tooLong.json()) as { name: string }).name).toBe("invalid_idempotency_key")
    const rejected = await send(email({ to: "not-an-address" }), { "Idempotency-Key": "later" })
    expect(rejected.status).toBe(422)
    const accepted = await send(email(), { "Idempotency-Key": "later" })
    expect(accepted.status).toBe(200)
    const max = await send(email({ subject: "Max" }), { "Idempotency-Key": "k".repeat(256) })
    expect(max.status).toBe(200)
    expect(runtime.instance("default").sent()).toHaveLength(2)
  })
})

describe("a response lost after acceptance", () => {
  test("a served socket returns no bytes; the email is already stored", async () => {
    const server = await createServer()
    try {
      const arm = async (preset: string) => {
        const response = await fetch(`${server.url}/__admin/faults`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preset, count: 1 }),
        })
        expect(response.status).toBe(201)
      }
      const post = (key: string) =>
        rawPost(server.port, server.host, httpSend(`${server.host}:${server.port}`, key))
      await arm("network_drop")
      expect((await post("never-stored")).length).toBe(0)
      expect(
        ((await (await fetch(`${server.url}/__admin/outbox`)).json()) as { messages: unknown[] })
          .messages,
      ).toEqual([])
      await arm("accepted_then_network_drop")
      expect((await post("lost-response")).length).toBe(0)
      const stored = (
        (await (await fetch(`${server.url}/__admin/outbox`)).json()) as {
          messages: { id: string; idempotencyKey: string | null }[]
        }
      ).messages
      expect(stored).toHaveLength(1)
      expect(stored[0]?.idempotencyKey).toBe("lost-response")
      const retry = await fetch(`${server.url}/emails`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer re_test",
          "Idempotency-Key": "lost-response",
        },
        body: JSON.stringify(email()),
      })
      expect(retry.status).toBe(200)
      expect(retry.headers.get("idempotent-replayed")).toBe("true")
      const storedId = stored[0]?.id
      if (storedId === undefined) throw new Error("missing stored email")
      expect(((await retry.json()) as { id: string }).id).toBe(storedId)
    } finally {
      await server.close()
    }
  })

  test("the lost send is counted, then the same key replays", async () => {
    const { runtime, call, send } = harness()
    runtime.applyPreset("accepted_then_network_drop", "default", { count: 1 })
    const headers = { "Idempotency-Key": "order-42" }
    await expect(send(email(), headers)).rejects.toThrow(TypeError)
    const stored = runtime.instance("default").sent()
    expect(stored).toHaveLength(1)
    const retry = await send(email(), headers)
    expect(retry.status).toBe(200)
    expect(retry.headers.get("idempotent-replayed")).toBe("true")
    const storedId = stored[0]?.id
    if (storedId === undefined) throw new Error("missing stored email")
    expect(((await retry.json()) as { id: string }).id).toBe(storedId)
    expect(runtime.instance("default").sent()).toHaveLength(1)
    const counts = { accepted: 1, lost: 1, replayed: 1 }
    expect(runtime.instance("default").sendOutcomes()).toEqual(counts)
    expect(await (await call("/__admin/outcomes")).json()).toEqual(counts)
    const metrics = runtime.metrics.report()
    expect(metrics.byOperation["SendEmail 0"]).toBe(1)
    expect(metrics.byOperation["SendEmail 200"]).toBe(1)
    expect(metrics.faults).toBe(1)
    const outcomes = runtime.journal
      .list()
      .map((entry) => (entry as { outcome?: string }).outcome)
      .filter((outcome) => outcome !== undefined)
    expect(outcomes).toEqual(["accepted", "lost", "replayed"])
    const accepted = runtime.journal.list()[0] as { ids?: { emailId?: string } }
    expect(accepted.ids?.emailId).toBe(stored[0]?.id)
  })

  test("network_drop stores nothing and does not count an outcome", async () => {
    const { runtime, send } = harness()
    runtime.applyPreset("network_drop", "default", { count: 1 })
    const headers = { "Idempotency-Key": "order-42" }
    await expect(send(email(), headers)).rejects.toThrow(TypeError)
    expect(runtime.instance("default").sent()).toEqual([])
    expect(runtime.instance("default").sendOutcomes()).toEqual({
      accepted: 0,
      lost: 0,
      replayed: 0,
    })
    const retry = await send(email(), headers)
    expect(retry.status).toBe(200)
    expect(retry.headers.get("idempotent-replayed")).toBeNull()
    expect(runtime.instance("default").sent()).toHaveLength(1)
  })

  test("an invalid send does not drop and does not persist", async () => {
    const { runtime, send } = harness()
    runtime.applyPreset("accepted_then_network_drop", "default", { count: 1 })
    const rejected = await send(email({ from: "not-an-address" }))
    expect(rejected.status).toBe(422)
    expect(runtime.instance("default").sent()).toEqual([])
    expect(runtime.instance("default").sendOutcomes()).toEqual({
      accepted: 0,
      lost: 0,
      replayed: 0,
    })
    expect((await send(email())).status).toBe(200)
  })
})

describe("validation and isolation", () => {
  test("missing and malformed fields are Resend's 422 and store nothing", async () => {
    const { runtime, send } = harness()
    const missingTo = await send(email({ to: undefined }))
    expect(missingTo.status).toBe(422)
    expect(((await missingTo.json()) as { message: string }).message).toBe("Missing `to` field.")
    const missingBody = await send(email({ html: undefined }))
    expect(missingBody.status).toBe(422)
    expect(((await missingBody.json()) as { message: string }).message).toBe(
      "Missing `html` or `text` field.",
    )
    const badFrom = (await (await send(email({ from: "not-an-address" }))).json()) as {
      name: string
      message: string
    }
    expect(badFrom.name).toBe("validation_error")
    expect(badFrom.message).toContain("Invalid `from` field")
    const badTag = await send(email({ tags: [{ name: "category", value: "has spaces" }] }))
    expect(((await badTag.json()) as { message: string }).message).toContain("Invalid `tags` field")
    expect(runtime.instance("default").sent()).toEqual([])
  })

  test("credentials, faults, outcomes, and reset stay in their namespace", async () => {
    const { runtime, call, send } = harness()
    const mapped = await call("/__admin/credentials", {
      method: "PUT",
      body: { credentials: { re_alpha: "alpha", re_beta: "beta" } },
    })
    expect(mapped.status).toBe(200)
    const headers = { "Idempotency-Key": "shared-key" }
    const alpha = await send(email({ subject: "Alpha" }), headers, "re_alpha")
    const beta = await send(email({ subject: "Beta" }), headers, "re_beta")
    expect(alpha.status).toBe(200)
    expect(beta.status).toBe(200)
    expect(runtime.instance("alpha").sent()[0]?.subject).toBe("Alpha")
    expect(runtime.instance("beta").sent()[0]?.subject).toBe("Beta")
    runtime.applyPreset("network_drop", "alpha", { count: 1 })
    await expect(send(email({ subject: "Again" }), {}, "re_alpha")).rejects.toThrow(TypeError)
    expect((await send(email({ subject: "Beta again" }), {}, "re_beta")).status).toBe(200)
    expect(runtime.instance("alpha").sent()).toHaveLength(1)
    expect(runtime.instance("beta").sent()).toHaveLength(2)
    expect(runtime.instance("alpha").sendOutcomes()).toEqual({ accepted: 0, lost: 0, replayed: 0 })
    expect(runtime.instance("beta").sendOutcomes()).toEqual({ accepted: 0, lost: 0, replayed: 0 })
    await runtime.reset("alpha")
    expect(runtime.instance("alpha").sent()).toEqual([])
    expect(runtime.instance("beta").sent()).toHaveLength(2)
    const betaOutcomes = await call("/__admin/outcomes", {
      headers: { "x-mockingbird-namespace": "beta" },
    })
    expect(await betaOutcomes.json()).toEqual({ accepted: 0, lost: 0, replayed: 0 })
  })

  test("the journal records the send id and omits the message", async () => {
    const token = "unsub-secret-token-196"
    const { runtime, call, send, logs } = harness()
    const sent = (await (
      await send(
        email({
          to: ["phi-recipient-196@example.com"],
          subject: "SubjectFragment196",
          text: "BodyFragment196",
          html: "<p>BodyFragment196</p>",
          headers: { "List-Unsubscribe": `<https://app.example.test/u?t=${token}>` },
        }),
        {},
        "re_secret_fixture_key",
      )
    ).json()) as { id: string }
    const journal = await (await call("/__admin/requests")).text()
    const recorded = `${journal}\n${JSON.stringify(logs)}`
    expect(recorded).toContain("SendEmail")
    expect(recorded).toContain(sent.id)
    expect(recorded).not.toContain(token)
    expect(recorded).not.toContain("re_secret_fixture_key")
    expect(recorded).not.toContain("SubjectFragment196")
    expect(recorded).not.toContain("phi-recipient-196")
    expect(recorded).not.toContain("BodyFragment196")
    expect(runtime.instance("default").sent()[0]?.id).toBe(sent.id)
  })
})

describe("resend SDK compatibility", () => {
  test(
    "4.8.0 never throws; 2.1.0 rejects a non-JSON body and a dropped socket",
    async () => {
      const v4 = await runSdk("4", "faults", "sdk4")
      const v2 = await runSdk("2", "faults", "sdk2")
      for (const report of [v4, v2]) {
        expect(report.leaked).toBe(false)
        expect(report.unhandled).toBe(false)
        expect(report.hosts).not.toContain("api.resend.com")
        expect(report.validation).toMatchObject({
          settled: "result",
          error: { name: "validation_error", statusCode: 422 },
        })
        expect(report.rateLimit).toMatchObject({
          settled: "result",
          error: { name: "rate_limit_exceeded", statusCode: 429 },
        })
        expect(report.internal).toMatchObject({
          settled: "result",
          error: { name: "internal_server_error", statusCode: 500 },
        })
        expect(report.outboxBefore).toBe(0)
      }
      expect(v4.nonJson).toMatchObject({
        settled: "result",
        error: {
          name: "application_error",
          message: expect.stringContaining("Internal server error"),
        },
      })
      expect(v4.networkDrop).toEqual({
        settled: "result",
        data: null,
        error: { name: "application_error", message: UNABLE },
      })
      expect(v4.acceptedDrop).toEqual({
        settled: "result",
        data: null,
        error: { name: "application_error", message: UNABLE },
      })
      expect(v4.outboxAfter).toBe(1)
      expect(v4.retry?.data?.id).toBe(v4.outboxIds?.[0])
      expect(v4.outcomes).toEqual({ accepted: 1, lost: 1, replayed: 1 })
      expect(v2.nonJson).toMatchObject({ settled: "rejected" })
      expect(v2.networkDrop).toEqual({ settled: "rejected", name: "TypeError" })
      expect(v2.acceptedDrop).toEqual({ settled: "rejected", name: "TypeError" })
      expect(v2.outboxAfter).toBe(2)
      expect(v2.outcomes).toEqual({ accepted: 1, lost: 1, replayed: 0 })
    },
    { timeout: 60_000 },
  )

  test(
    "both SDKs send against the mock",
    async () => {
      for (const sdk of ["4", "2"] as const) {
        const report = await runSdk(sdk, "base", `base${sdk}`)
        expect(report.leaked).toBe(false)
        expect(report.hosts).not.toContain("api.resend.com")
        expect(report.send?.settled).toBe("result")
        expect(report.send?.error).toBeNull()
        expect(report.send?.data?.id).toMatch(UUID)
      }
    },
    { timeout: 60_000 },
  )
})
