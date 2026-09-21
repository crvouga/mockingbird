import { describe, expect, test } from "bun:test"
import { createRuntime, MAILOSAUR_PRESETS } from "./src/index.js"
import { createServer, serveTarget } from "./src/server.js"

const API = "http://mailosaur.mock"
const SERVER = "abcd1234"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }
const basic = (key: string) => `Basic ${btoa(`${key}:`)}`

const harness = () => {
  const runtime = createRuntime()
  const call = (
    path: string,
    init: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
  ) =>
    runtime.fetch(
      new Request(`${API}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.key === "" ? {} : { authorization: basic(init.key ?? "key") }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  const ingest = (body: unknown, namespace?: string) =>
    call("/__admin/ingest", {
      body,
      ...(namespace ? { headers: { "x-mockingbird-namespace": namespace } } : {}),
    })
  const search = async (criteria: unknown, key = "key", query = "") =>
    (await (
      await call(`/api/messages/search?server=${SERVER}${query}`, { body: criteria, key })
    ).json()) as { items: { id: string; subject: string }[] }
  return { runtime, call, ingest, search }
}

describe("the service contract", () => {
  test("health is unauthenticated and every response carries x-mockingbird", async () => {
    const { call } = harness()
    const health = await call("/health", { key: "" })
    expect(health.status).toBe(200)
    expect(((await health.json()) as { status: string }).status).toBe("ok")
    const denied = await call(`/api/messages?server=${SERVER}`, { key: "" })
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({
      type: "authentication_error",
      message: "Authentication failed, check your API key.",
    })
    expect(denied.headers.get("x-mockingbird")).toMatch(/^mailosaur@.+; ns=default$/)
  })

  test("namespaces by header, by /ns/ prefix and by API key are isolated", async () => {
    const { call, ingest, search } = harness()
    await ingest({ to: `x@${SERVER}.mailosaur.net`, subject: "in a" }, "a")
    const viaHeader = await call(`/api/messages?server=${SERVER}`, {
      headers: { "x-mockingbird-namespace": "a" },
    })
    expect(((await viaHeader.json()) as { items: unknown[] }).items).toHaveLength(1)
    const viaPrefix = await call(`/ns/a/api/messages?server=${SERVER}`)
    expect(((await viaPrefix.json()) as { items: unknown[] }).items).toHaveLength(1)
    await call("/__admin/credentials", { method: "PUT", body: { credentials: { "key-a": "a" } } })
    expect((await search({}, "key-a")).items.map((m) => m.subject)).toEqual(["in a"])
    expect((await search({}, "key-b")).items).toEqual([])
  })

  test("the journal records operations and ids, never message bodies", async () => {
    const { call, ingest, search } = harness()
    await ingest({ to: `j@${SERVER}.mailosaur.net`, subject: "secret subject", text: "PHI 918273" })
    const [first] = (await search({ sentTo: `j@${SERVER}.mailosaur.net` })).items
    await call(`/api/messages/${first?.id}`)
    const journal = await (await call("/__admin/requests")).text()
    expect(journal).toContain("GetMessage")
    expect(journal).toContain(first?.id as string)
    expect(journal).not.toContain("secret subject")
    expect(journal).not.toContain("918273")
  })

  test("every preset is registered and behaves as described", async () => {
    expect(Object.keys(MAILOSAUR_PRESETS).sort()).toEqual([
      "auth_failed",
      "rate_limited",
      "search_never_matches",
      "server_error",
      "slow_search",
    ])
    const { runtime, call, ingest, search } = harness()
    await ingest({ to: `p@${SERVER}.mailosaur.net`, subject: "p" })
    runtime.applyPreset("auth_failed", "default", { count: 1 })
    expect((await call(`/api/messages?server=${SERVER}`)).status).toBe(401)
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    expect((await call(`/api/messages/search?server=${SERVER}`, { body: {} })).status).toBe(429)
    runtime.applyPreset("server_error", "default", { count: 1 })
    expect((await call(`/api/messages?server=${SERVER}`)).status).toBe(500)
    runtime.applyPreset("search_never_matches", "default", { count: 1 })
    expect((await search({})).items).toEqual([])
    expect((await search({})).items).toHaveLength(1)
    const presets = (await (await call("/__admin/faults/presets")).json()) as {
      presets: { name: string }[]
    }
    expect(presets.presets.map((p) => p.name)).toContain("slow_search")
  })
})

describe("search, ingest and the admin plane", () => {
  test("criteria: sentTo/sentFrom exact (case-insensitive), subject/body contains, ALL vs ANY", async () => {
    const { ingest, search } = harness()
    await ingest({
      to: [`Ada <ada@${SERVER}.mailosaur.net>`],
      cc: `cc@${SERVER}.mailosaur.net`,
      from: "Geviti <no-reply@gogeviti.com>",
      subject: "Reset your password",
      html: "<p>Click <a href='https://app.test/reset?token=abc'>here</a></p>",
    })
    await ingest({ to: `bob@${SERVER}.mailosaur.net`, subject: "Welcome", text: "hello bob" })
    const subjects = async (criteria: unknown) =>
      (await search(criteria)).items.map((m) => m.subject)
    expect(await subjects({ sentTo: `ADA@${SERVER}.mailosaur.net` })).toEqual([
      "Reset your password",
    ])
    expect(await subjects({ sentTo: `cc@${SERVER}.mailosaur.net` })).toEqual([
      "Reset your password",
    ])
    expect(await subjects({ sentFrom: "no-reply@gogeviti.com" })).toEqual(["Reset your password"])
    expect(await subjects({ subject: "welcome" })).toEqual(["Welcome"])
    expect(await subjects({ body: "click here" })).toEqual(["Reset your password"])
    expect(await subjects({ subject: "welcome", body: "click", match: "ALL" })).toEqual([])
    expect(await subjects({ subject: "welcome", body: "click", match: "ANY" })).toEqual([
      "Welcome",
      "Reset your password",
    ])
  })

  test("paging, direction and the x-ms-delay poll hint (settable per namespace)", async () => {
    const { call, ingest, search } = harness()
    for (const n of [1, 2, 3]) await ingest({ to: `p@${SERVER}.mailosaur.net`, subject: `m${n}` })
    expect((await search({}, "key", "&itemsPerPage=2")).items.map((m) => m.subject)).toEqual([
      "m3",
      "m2",
    ])
    expect((await search({}, "key", "&itemsPerPage=2&page=1")).items.map((m) => m.subject)).toEqual(
      ["m1"],
    )
    expect((await search({}, "key", "&dir=Ascending")).items.map((m) => m.subject)).toEqual([
      "m1",
      "m2",
      "m3",
    ])
    const first = await call(`/api/messages/search?server=${SERVER}`, { body: {} })
    expect(first.headers.get("x-ms-delay")).toBe("20")
    await call("/__admin/settings", { method: "PUT", body: { pollDelaysMs: [5, 10, 50] } })
    const tuned = await call(`/api/messages/search?server=${SERVER}`, { body: {} })
    expect(tuned.headers.get("x-ms-delay")).toBe("5,10,50")
    const bad = await call("/__admin/settings", { method: "PUT", body: { pollDelaysMs: [] } })
    expect(bad.status).toBe(400)
  })

  test("servers: from the recipient's <id>.mailosaur.net domain, explicit, or visible everywhere", async () => {
    const { ingest, search, call } = harness()
    await ingest({ to: `a@${SERVER}.mailosaur.net`, subject: "by domain" })
    await ingest({ to: "b@example.com", server: "other123", subject: "explicit" })
    await ingest({ to: "c@example.com", subject: "anywhere" })
    expect((await search({})).items.map((m) => m.subject)).toEqual(["anywhere", "by domain"])
    const other = (await (await call("/api/messages?server=other123")).json()) as {
      items: { subject: string; server: string }[]
    }
    expect(other.items.map((m) => m.subject)).toEqual(["anywhere", "explicit"])
    expect(other.items[1]?.server).toBe("other123")
  })

  test("SMS ingest: phone recipients, text codes", async () => {
    const { ingest, search } = harness()
    const response = await ingest({
      type: "SMS",
      to: "+15555550100",
      from: "+15555550199",
      text: "Your Geviti code is 482913",
    })
    const message = (await response.json()) as {
      type: string
      to: { phone: string }[]
      text: { codes: { value: string }[] }
    }
    expect(message.type).toBe("SMS")
    expect(message.to[0]?.phone).toBe("+15555550100")
    expect(message.text.codes).toEqual([{ value: "482913" }])
    expect((await search({ sentTo: "+15555550100" })).items).toHaveLength(1)
  })

  test("ingest validation, outbox listing and the links route", async () => {
    const { call, ingest } = harness()
    expect((await ingest({ subject: "no recipient" })).status).toBe(400)
    expect((await ingest({ to: [] })).status).toBe(400)
    expect((await ingest({ to: "a@b.co", type: "Fax" })).status).toBe(400)
    const created = (await (
      await ingest({
        to: "Invitee <invitee@example.com>",
        subject: "Invitation",
        html: '<a href="https://emr.test/sign-up?invite=k1&amp;type=provider">Accept</a> <a href="https://emr.test/help">Help</a>',
        text: "Accept at https://emr.test/sign-up?invite=k1&type=provider",
        attachments: [{ filename: "a.txt", content: btoa("hello"), contentType: "text/plain" }],
      })
    ).json()) as { id: string; attachments: { fileName: string; length: number }[] }
    expect(created.attachments[0]).toMatchObject({ fileName: "a.txt", length: 5 })
    const outbox = (await (await call("/__admin/outbox?to=invitee@example.com")).json()) as {
      messages: { id: string }[]
    }
    expect(outbox.messages.map((m) => m.id)).toEqual([created.id])
    const none = (await (await call("/__admin/outbox?to=nobody@example.com")).json()) as {
      messages: unknown[]
    }
    expect(none.messages).toEqual([])
    const links = (await (await call(`/__admin/outbox/${created.id}/links`)).json()) as {
      links: string[]
    }
    expect(links.links).toEqual([
      "https://emr.test/sign-up?invite=k1&type=provider",
      "https://emr.test/help",
    ])
    expect((await call("/__admin/outbox/nope/links")).status).toBe(404)
  })

  test("await (server-side long-poll): resolves within 50 ms of arrival, 404 on timeout", async () => {
    const { runtime, call } = harness()
    const to = `wait@${SERVER}.mailosaur.net`
    const pending = call(`/api/messages/await?server=${SERVER}&timeout=5000`, {
      body: { sentTo: to },
    }).then(async (response) => ({ response, at: performance.now() }))
    await Bun.sleep(100)
    const arrived = performance.now()
    runtime.instance().ingest({ to, subject: "arrived", text: "code 555111" })
    const { response, at } = await pending
    expect(response.status).toBe(200)
    expect(((await response.json()) as { subject: string }).subject).toBe("arrived")
    expect(at - arrived).toBeLessThan(50)
    const byQuery = await call(`/api/messages/await?server=${SERVER}&sentTo=${to}&timeout=0`)
    expect(byQuery.status).toBe(200)
    const timedOut = await call(`/api/messages/await?server=${SERVER}&timeout=100`, {
      body: { sentTo: "nobody@example.com" },
    })
    expect(timedOut.status).toBe(404)
    expect(((await timedOut.json()) as { type: string }).type).toBe("search_timeout")
    const bad = await call(`/api/messages/await?server=${SERVER}&timeout=999999`, { body: {} })
    expect(bad.status).toBe(400)
    const missingServer = await call("/api/messages/await", { body: {} })
    expect(((await missingServer.json()) as { errors: { field: string }[] }).errors[0]?.field).toBe(
      "server",
    )
  })

  test("reset releases pending long-polls and clears the inbox", async () => {
    const { runtime, call, ingest, search } = harness()
    await ingest({ to: `r@${SERVER}.mailosaur.net`, subject: "r" })
    const pending = call(`/api/messages/await?server=${SERVER}&timeout=10000`, {
      body: { sentTo: "later@example.com" },
    })
    await Bun.sleep(20)
    await runtime.reset()
    expect((await pending).status).toBe(404)
    expect((await search({})).items).toEqual([])
  })
})

describe("served over HTTP and HTTPS", () => {
  test("plain fetch over HTTP, HTTPS with the generated certificate, and the CONNECT door", async () => {
    const server = await createServer({ tls: true })
    try {
      const headers = { authorization: basic("k"), "content-type": "application/json" }
      await fetch(`${server.url}/__admin/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({ to: `h@${SERVER}.mailosaur.net`, subject: "over http" }),
      })
      const plain = await fetch(`${server.url}/api/messages?server=${SERVER}`, { headers })
      expect(((await plain.json()) as { items: unknown[] }).items).toHaveLength(1)
      const secure = await fetch(`${server.tlsUrl}/api/messages?server=${SERVER}`, {
        headers,
        tls: { ca: server.cert },
      } as RequestInit)
      expect(((await secure.json()) as { items: unknown[] }).items).toHaveLength(1)
      // The secure port also answers plain HTTP.
      const door = await fetch(`${server.proxyUrl}/health`)
      expect(door.headers.get("x-mockingbird")).toMatch(/^mailosaur@/)
    } finally {
      await server.close()
    }
  })

  test("the serve target builds a runtime from flags", async () => {
    const runtime = await serveTarget.create({ "poll-delay": "5,15" }, COMMON)
    const response = await runtime.fetch(
      new Request(`${API}/api/messages/search?server=${SERVER}`, {
        method: "POST",
        headers: { authorization: basic("k"), "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.headers.get("x-ms-delay")).toBe("5,15")
    await expect(
      Promise.resolve().then(() => serveTarget.create({ "poll-delay": "fast" }, COMMON)),
    ).rejects.toThrow("--poll-delay")
  })
})
