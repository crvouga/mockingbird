import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { FetchRequestClient } from "./test/consumer.js"
import { RequestClient, Twilio } from "./test/twilio-sdk.js"

const ACCOUNT = `AC${"0".repeat(32)}`
const OTHER = `AC${"1".repeat(32)}`
const base = (account = ACCOUNT) => `/api/2010-04-01/Accounts/${account}/Messages.json`
/** The same collection as api.twilio.com serves it: no product prefix. */
const upstream = (account = ACCOUNT) => `/2010-04-01/Accounts/${account}/Messages.json`

/**
 * twilio-node pointed at the mock origin as a stand-in for `https://api.twilio.com` itself
 * (no `/api` product prefix): what a proxy or an edge/base-URL override does.
 */
class RootRequestClient extends RequestClient {
  constructor(private readonly send: (request: Request) => Promise<Response>) {
    super()
  }
  override async request(opts: Parameters<RequestClient["request"]>[0]): Promise<never> {
    const url = new URL(opts.uri)
    if (url.hostname !== "api.twilio.com") throw new Error(`unexpected host ${url.hostname}`)
    return new FetchRequestClient("http://mock.test", (request) => {
      const routed = new URL(request.url)
      routed.pathname = routed.pathname.replace(/^\/api(?=\/)/, "")
      return this.send(new Request(routed, request))
    }).request(opts)
  }
}

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  const send = (request: Request) => runtime.fetch(request)
  const request = (path: string, body?: unknown, account = ACCOUNT) =>
    send(
      new Request(`http://mock.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Basic ${btoa(`${account}:fixture-token`)}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const client = new Twilio(ACCOUNT, "fixture-token", {
    httpClient: new FetchRequestClient("http://mock.test", send),
  })
  const create = (body: string) =>
    client.messages.create({ to: "+12025550123", from: "+12025550124", body })
  return { runtime, send, request, client, create }
}

describe("Message collection reconciliation (#257)", () => {
  test("accepted Message resources are listed with their current status and dates", async () => {
    const { create, request } = harness()
    const message = await create("synthetic message")
    const response = await request(base())
    expect(response.status).toBe(200)
    const page = (await response.json()) as {
      messages: { sid: string; status: string; date_created: string }[]
    }
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ sid: message.sid, status: message.status })
    const detail = await (
      await request(`${base().replace(".json", "")}/${message.sid}.json`)
    ).json()
    expect(page.messages[0]).toEqual(detail)
  })

  test("raw next-page links enumerate every SID exactly once and terminate", async () => {
    const { create, request } = harness()
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await create(`fixture-${i}`)).sid)
    let path: string | null = `${base()}?PageSize=1`
    const seen = []
    for (let i = 0; i < 3; i++) {
      if (!path) throw new Error("pagination ended early")
      const response = await request(path)
      expect(response.status).toBe(200)
      const page = (await response.json()) as {
        messages: { sid: string }[]
        next_page_uri: string | null
      }
      expect(page.messages).toHaveLength(1)
      seen.push(page.messages[0]?.sid)
      // Apply the same documented product prefix as the app's URL rewrite.
      path = page.next_page_uri ? `/api${page.next_page_uri}` : null
    }
    expect(path).toBeNull()
    expect(seen).toEqual([...ids].reverse())
  })

  test("the unmodified SDK follows collection pagination", async () => {
    const { create, client } = harness()
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await create(`sdk-fixture-${i}`)).sid)
    const messages = await client.messages.list({ pageSize: 1, limit: 10 })
    expect(messages.map((message) => message.sid)).toEqual([...ids].reverse())
    expect(messages.every((message) => message.dateCreated instanceof Date)).toBe(true)
  })

  test("another account and namespace cannot see the first account's messages", async () => {
    const { create, request } = harness()
    await create("fixture-isolated")
    for (const path of [base(OTHER), `/__admin/ns/other${base()}`]) {
      const page = (await (await request(path, undefined, OTHER)).json()) as {
        messages: unknown[]
        next_page_uri: string | null
      }
      expect(page.messages).toEqual([])
      expect(page.next_page_uri).toBeNull()
    }
  })

  test("auth, invalid cursors, reset and transient failures preserve collection state", async () => {
    const { create, request, send } = harness()
    await create("fixture-fault")
    expect((await send(new Request(`http://mock.test${base()}`))).status).toBe(401)
    expect((await request(`${base()}?PageToken=invalid`)).status).toBe(400)
    expect((await request(`${base()}?PageSize=0`)).status).toBe(400)
    for (const status of [429, 500]) {
      expect(
        (
          await request("/__admin/faults", {
            method: "GET",
            pathPrefix: base(),
            status,
            count: 1,
            body: {
              code: 20003,
              message: "synthetic failure",
              status,
              more_info: "https://www.twilio.com/docs/errors/20003",
            },
          })
        ).status,
      ).toBe(201)
      expect((await request(base())).status).toBe(status)
      const page = (await (await request(base())).json()) as { messages: unknown[] }
      expect(page.messages).toHaveLength(1)
    }
    await request("/__admin/reset", {})
    expect(await (await request(base())).json()).toMatchObject({
      messages: [],
      next_page_uri: null,
    })
  })

  test("#762: the un-prefixed /2010-04-01 list accepts the credentials /api accepts", async () => {
    const { create, request, send } = harness()
    for (let i = 0; i < 2; i++) await create(`fixture-root-${i}`)
    const sids = async (response: Response) => {
      expect(response.status).toBe(200)
      return ((await response.json()) as { messages: { sid: string }[] }).messages.map((m) => m.sid)
    }
    const expected = await sids(await request(`${base()}?PageSize=1`))
    expect(expected).toHaveLength(1)
    expect(await sids(await request(`${upstream()}?PageSize=1`))).toEqual(expected)
    const authorization = `Basic ${btoa(`${ACCOUNT}:fixture-token`)}`
    for (const url of [`http://mock.test${upstream()}`, `https://api.twilio.com${upstream()}`]) {
      const hosted = new Request(`${url}?PageSize=1`, {
        headers: { authorization, host: "api.twilio.com" },
      })
      expect(await sids(await send(hosted))).toEqual(expected)
    }
    // Behind a namespace, another account sees its own (empty) collection.
    expect(
      await sids(await request(`/__admin/ns/other${upstream(OTHER)}`, undefined, OTHER)),
    ).toEqual([])
    // The credential rule itself is unchanged: none, or a non-account username, is 401 20003.
    for (const headers of [{}, { authorization: `Basic ${btoa("user:pass")}` }]) {
      const denied = await send(new Request(`http://mock.test${upstream()}`, { headers }))
      expect(denied.status).toBe(401)
      expect(await denied.json()).toMatchObject({ code: 20003 })
    }
    const strict = createRuntime({ accounts: { [ACCOUNT]: "right-token" } })
    const wrong = await strict.fetch(
      new Request(`http://mock.test${upstream()}`, {
        headers: { authorization: `Basic ${btoa(`${ACCOUNT}:wrong-token`)}` },
      }),
    )
    expect(wrong.status).toBe(401)
  })

  test("#762: page URIs are api.twilio.com paths that a raw client follows from the mock origin", async () => {
    const { create, request } = harness()
    const ids = []
    for (let i = 0; i < 2; i++) ids.push((await create(`fixture-raw-${i}`)).sid)
    for (const start of [`${base()}?PageSize=1`, `${upstream()}?PageSize=1`]) {
      let path: string | null = start
      const seen = []
      for (let i = 0; i < 2; i++) {
        if (!path) throw new Error("pagination ended early")
        const response = await request(path)
        expect(response.status).toBe(200)
        const page = (await response.json()) as {
          messages: { sid: string }[]
          uri: string
          first_page_uri: string
          next_page_uri: string | null
          previous_page_uri: string | null
        }
        for (const uri of [page.uri, page.first_page_uri, page.next_page_uri ?? upstream()]) {
          expect(uri.startsWith(`${upstream()}?`) || uri === upstream()).toBe(true)
        }
        if (i === 1) expect(page.previous_page_uri?.startsWith(`${upstream()}?`)).toBe(true)
        seen.push(page.messages[0]?.sid)
        path = page.next_page_uri
      }
      expect(path).toBeNull()
      expect(seen).toEqual([...ids].reverse())
    }
  })

  test("#762: the SDK pages PageSize=1 across two pages with or without the /api prefix", async () => {
    const { create, send, client } = harness()
    const older = (await create("sdk-mount-0")).sid
    const newer = (await create("sdk-mount-1")).sid
    const root = new Twilio(ACCOUNT, "fixture-token", { httpClient: new RootRequestClient(send) })
    for (const sdk of [client, root]) {
      const first = await sdk.messages.page({ pageSize: 1 })
      expect(first.instances.map((message) => message.sid)).toEqual([newer])
      const second = await first.nextPage()
      expect(second?.instances.map((message) => message.sid)).toEqual([older])
      expect(second?.nextPageUrl).toBeUndefined()
      const all = await sdk.messages.list({ pageSize: 1, limit: 10 })
      expect(all.map((message) => message.sid)).toEqual([newer, older])
    }
  })
})
