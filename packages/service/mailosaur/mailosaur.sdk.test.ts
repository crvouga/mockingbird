/**
 * The official `mailosaur` SDK (11.1.0, the version our backend pins), unmodified, against the
 * mock. The SDK only speaks HTTPS and always connects to port 443 (it passes the base URL's
 * hostname and path to `https.request` but drops its port), so it cannot be pointed at a mock
 * on another port by base URL alone. It does honour `HTTPS_PROXY` (read once, when a client is
 * constructed): the mock's secure port is also a CONNECT proxy that tunnels every target into
 * the mock. So each client here is built with `HTTPS_PROXY` set and the default base URL
 * `https://mailosaur.com/`, and nothing ever reaches mailosaur.com. The mock's generated
 * certificate (which names mailosaur.com) is trusted for the test's duration, as
 * `NODE_EXTRA_CA_CERTS` would trust it for the app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import tls from "node:tls"
import MailosaurNode from "mailosaur"
import { MailosaurError, SearchCriteria, SearchOptions } from "mailosaur/models"
import { createServer, type MailosaurServer } from "./src/server.js"

const SERVER = "abcd1234"

let server: MailosaurServer
const trust = tls as unknown as {
  getCACertificates(kind: "default"): string[]
  setDefaultCACertificates(certs: string[]): void
}
let previousCa: string[] = []

/** A client built exactly as our backend builds it, with the proxy in the environment. */
const sdk = (key = "sdk-key", baseUrl?: string) => {
  process.env.HTTPS_PROXY = server.proxyUrl
  try {
    return new MailosaurNode(key, baseUrl)
  } finally {
    // Bun caches a proxy it has seen until the variable is set to "" (a bare delete keeps it).
    process.env.HTTPS_PROXY = ""
    delete process.env.HTTPS_PROXY
  }
}
const ingest = (body: Record<string, unknown>, namespace = "default") =>
  server.runtime.instance(namespace).ingest(body as never)

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as MailosaurError
  }
  throw new Error("expected the SDK call to reject")
}

beforeAll(async () => {
  server = await createServer({ tls: true })
  previousCa = trust.getCACertificates("default")
  trust.setDefaultCACertificates([...previousCa, server.cert as string])
})

afterAll(async () => {
  trust.setDefaultCACertificates(previousCa)
  await server.close()
})

describe("mailosaur@11.1.0 SDK against the mock", () => {
  test("messages.get finds an already-delivered message and exposes parsed content", async () => {
    await server.runtime.reset("*")
    ingest({
      to: `signup-1@${SERVER}.mailosaur.net`,
      from: "Acme <no-reply@acme.example>",
      subject: "Your verification code",
      html: '<p>Your verification code is <b>482913</b>.</p><a href="https://app.test/confirm?c=482913">Confirm</a><img src="https://cdn.test/logo.png" alt="Logo">',
      text: "Your verification code is 482913. Confirm at https://app.test/confirm?c=482913",
    })
    const message = await sdk().messages.get(
      SERVER,
      new SearchCriteria({ sentTo: `signup-1@${SERVER}.mailosaur.net` }),
      new SearchOptions({ timeout: 2_000 }),
    )
    expect(message.subject).toBe("Your verification code")
    expect(message.from?.[0]).toMatchObject({ name: "Acme", email: "no-reply@acme.example" })
    expect(message.to?.[0]?.email).toBe(`signup-1@${SERVER}.mailosaur.net`)
    expect(message.html?.codes?.map((c) => c.value)).toEqual(["482913"])
    expect(message.text?.codes?.map((c) => c.value)).toEqual(["482913"])
    expect(message.html?.links?.[0]).toMatchObject({
      href: "https://app.test/confirm?c=482913",
      text: "Confirm",
    })
    expect(message.text?.links?.[0]?.href).toBe("https://app.test/confirm?c=482913")
    expect(message.html?.images?.[0]).toMatchObject({
      src: "https://cdn.test/logo.png",
      alt: "Logo",
    })
    expect(message.received).toBeInstanceOf(Date)
    expect(message.server).toBe(SERVER)
  })

  test("messages.get long-polls and returns within 50 ms of the message arriving", async () => {
    await server.runtime.reset("*")
    const client = sdk()
    // The same search + getById round trips for mail already there: transport and scheduler
    // cost the mock does not control. Mail landing just after a poll left also waits out that
    // in-flight empty search (at most one more round trip), so the 50 ms bound is what the mock
    // itself adds on top.
    const early = `early@${SERVER}.mailosaur.net`
    ingest({ to: early, subject: "early", text: "Your verification code is 654321." })
    const started = performance.now()
    await client.messages.get(SERVER, new SearchCriteria({ sentTo: early }))
    const baseline = performance.now() - started
    const to = `late@${SERVER}.mailosaur.net`
    let arrived = 0
    const pending = client.messages
      .get(SERVER, new SearchCriteria({ sentTo: to }), new SearchOptions({ timeout: 10_000 }))
      .then((message) => ({ message, at: performance.now() }))
    await Bun.sleep(300)
    arrived = performance.now()
    ingest({ to, subject: "late", text: "Your verification code is 123456." })
    const { message, at } = await pending
    expect(message.subject).toBe("late")
    expect(at - arrived).toBeLessThan(2 * baseline + 50)
  })

  test("messages.get times out with the SDK's search_timeout error when nothing arrives", async () => {
    await server.runtime.reset("*")
    const error = await rejection(
      sdk().messages.get(
        SERVER,
        new SearchCriteria({ sentTo: `nobody@${SERVER}.mailosaur.net` }),
        new SearchOptions({ timeout: 300 }),
      ),
    )
    expect(error).toBeInstanceOf(MailosaurError)
    expect(error.errorType).toBe("search_timeout")
  })

  test("receivedAfter hides older mail; the newest match wins", async () => {
    await server.runtime.reset("*")
    const to = `again@${SERVER}.mailosaur.net`
    ingest({ to, subject: "first", text: "code 111111" })
    server.runtime.clock.advance(5_000)
    const cutoff = new Date(server.runtime.clock.now() - 1_000)
    ingest({ to, subject: "second", text: "code 222222" })
    const newest = await sdk().messages.get(SERVER, new SearchCriteria({ sentTo: to }), {
      timeout: 1_000,
    })
    expect(newest.subject).toBe("second")
    const list = await sdk().messages.search(SERVER, new SearchCriteria({ sentTo: to }), {
      receivedAfter: cutoff,
    })
    expect(list.items?.map((m) => m.subject)).toEqual(["second"])
    server.runtime.clock.reset()
  })

  test("getById, del and deleteAll behave like the vendor (204s, then 404)", async () => {
    await server.runtime.reset("*")
    const client = sdk()
    const a = ingest({ to: `a@${SERVER}.mailosaur.net`, subject: "a", text: "hi" })
    ingest({ to: `b@${SERVER}.mailosaur.net`, subject: "b", text: "hi" })
    ingest({ to: "c@elsewhere.test", server: "zzzz9999", subject: "c", text: "hi" })
    expect((await client.messages.getById(a.id)).subject).toBe("a")
    await client.messages.del(a.id)
    const gone = await rejection(client.messages.getById(a.id))
    expect(gone.errorType).toBe("invalid_request")
    expect(gone.httpStatusCode).toBe(404)
    expect((await client.messages.list(SERVER)).items?.map((m) => m.subject)).toEqual(["b"])
    await client.messages.deleteAll(SERVER)
    expect((await client.messages.list(SERVER)).items).toEqual([])
    expect((await client.messages.list("zzzz9999")).items?.map((m) => m.subject)).toEqual(["c"])
    const missing = await rejection(client.messages.del(a.id))
    expect(missing.httpStatusCode).toBe(404)
  })

  test("messages.create stores a message in the server", async () => {
    await server.runtime.reset("*")
    const created = await sdk().messages.create(SERVER, {
      to: "someone@example.com",
      subject: "Hello",
      html: "<p>Code 777777</p>",
      send: true,
    })
    expect(created.server).toBe(SERVER)
    expect(created.html?.codes?.[0]?.value).toBe("777777")
    expect((await sdk().messages.getById(created.id as string)).subject).toBe("Hello")
  })

  test("the SDK's client-side and HTTP error mapping", async () => {
    const shortId = await rejection(
      sdk().messages.get("short", new SearchCriteria({ sentTo: "x@y.z" })),
    )
    expect(shortId.message).toBe("Must provide a valid Server ID.")
    const bad = await rejection(
      sdk().messages.list(SERVER, { receivedAfter: "not-a-date" as never }),
    )
    expect(bad.errorType).toBe("invalid_request")
    expect(bad.httpStatusCode).toBe(400)
    expect(bad.message).toContain("(receivedAfter) The value is not a valid date.")
    server.runtime.applyPreset("auth_failed", "default", { count: 1 })
    const denied = await rejection(sdk().messages.list(SERVER))
    expect(denied.errorType).toBe("authentication_error")
    server.runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await rejection(
      sdk().messages.search(SERVER, new SearchCriteria({ sentTo: "x@y.z" })),
    )
    expect(limited.errorType).toBe("api_error")
    expect(limited.httpStatusCode).toBe(429)
  })

  test("API keys map to namespaces, so parallel workers never see each other's mail", async () => {
    await server.runtime.reset("*")
    await fetch(`${server.url}/__admin/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { "worker-a-key": "wa", "worker-b-key": "wb" } }),
    })
    const to = `shared@${SERVER}.mailosaur.net`
    ingest({ to, subject: "for a", text: "code 313131" }, "wa")
    const a = await sdk("worker-a-key").messages.search(SERVER, new SearchCriteria({ sentTo: to }))
    const b = await sdk("worker-b-key").messages.search(SERVER, new SearchCriteria({ sentTo: to }))
    expect(a.items?.map((m) => m.subject)).toEqual(["for a"])
    expect(b.items).toEqual([])
  })
})
