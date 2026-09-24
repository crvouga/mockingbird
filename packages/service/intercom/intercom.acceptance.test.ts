import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, INTERCOM_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  BackendWebhookReceiver,
  EmrWebhookReceiver,
  HttpException,
  IntercomApiAdapter,
  type IntercomContactPayload,
  IntercomMessagingAdapter,
  NotFoundException,
} from "./test/consumer.js"

const API = "http://intercom.mock"
const TOKEN = "ic-access-token"
const SECRET = "intercom-webhook-secret"
const BACKEND_HOOK = "http://backend.local/messaging/webhook"
const EMR_HOOK = "http://emr.local/v1/webhooks/intercom"

type Delivery = { url: string; signature: string | null; body: string }

const harness = () => {
  const deliveries: Delivery[] = []
  const runtime = createRuntime({
    webhooks: {
      urls: [BACKEND_HOOK, EMR_HOOK],
      secret: SECRET,
      fetch: async (request) => {
        deliveries.push({
          url: request.url,
          signature: request.headers.get("x-hub-signature"),
          body: await request.text(),
        })
        return new Response(null, { status: 200 })
      },
    },
  })
  const send = (request: Request) => runtime.fetch(request)
  const messaging = new IntercomMessagingAdapter(API, TOKEN, send)
  const sync = new IntercomApiAdapter(API, { accessToken: TOKEN, syncEnabled: true }, send)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const flush = async () => {
    await runtime.webhooks.idle()
    return deliveries.splice(0)
  }
  return { runtime, messaging, sync, admin, deliveries, flush, send }
}

const payload = (userId: number, email: string): IntercomContactPayload => ({
  external_id: String(userId),
  email,
  name: "Ada Lovelace",
  phone: "+15125550142",
  signed_up_at: 1_700_000_000,
  custom_attributes: {
    acme_user_id: userId,
    medplum_user_id: "mp-1",
    membership_tier: "plus",
    payment_status: "paid",
    next_payment_on: 1_760_000_000,
    cancel_at_period_end: false,
    billing_frequency: "monthly",
    subscription_started_at: 1_700_000_000,
    user_created_at: 1_690_000_000,
    is_signup_complete: true,
    has_scheduled_initial_bloodwork: true,
    last_lab_date: 1_750_000_000,
    lab_count: 2,
    is_cancelling: false,
    state: "TX",
    city: "Austin",
    zip: "78701",
    subscription_active: true,
    next_free_bloodwork_date: null,
    visit_credits_available: true,
    has_scheduled_visit: false,
    longevity_specialist: "Dr. Mock",
    blueprint_delivered: true,
    rx_therapy_active: false,
    blend_subscription_active: false,
    last_synced_at: 1_760_000_100,
  },
})

describe("S16 acceptance: the sync adapter against the mock", () => {
  test("create → 409 on duplicate → search → PUT; external_id first, then email", async () => {
    const { sync, runtime } = harness()
    const first = await sync.createContact(payload(1652, "ada@example.com"))
    expect(first.action).toBe("created")
    const again = await sync.createContact({ ...payload(1652, "ada@example.com"), name: "Ada L." })
    expect(again).toEqual({ id: first.id, action: "updated" })
    expect(sync.logs.at(-1)).toContain("Contact already exists (409)")
    const stored = runtime.instance().state.contacts.get(first.id)
    expect(stored?.name).toBe("Ada L.")
    expect(stored?.custom_attributes.membership_tier).toBe("plus")
    // No external_id match falls back to the (lower-cased) email.
    const byEmail = await sync.findContact(9999, "ADA@example.com")
    expect(byEmail?.id).toBe(first.id)
    expect(await sync.findContact(9999, "nobody@example.com")).toBeNull()
  })

  test("the 409 carries Intercom's error envelope", async () => {
    const { send, sync } = harness()
    await sync.createContact(payload(1, "one@example.com"))
    const response = await send(
      new Request(`${API}/contacts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "intercom-version": "2.11",
        },
        body: JSON.stringify({ role: "user", external_id: "1", email: "other@example.com" }),
      }),
    )
    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      type: string
      errors: { code: string; message: string }[]
    }
    expect(body.type).toBe("error.list")
    expect(body.errors[0]?.code).toBe("conflict")
    expect(body.errors[0]?.message).toMatch(/already exists with id=[0-9a-f]{24}$/)
  })

  test("more than one email match logs a warning and uses the first", async () => {
    const { sync, send } = harness()
    for (const externalId of ["a", "b"]) {
      await send(
        new Request(`${API}/contacts`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            role: "lead",
            external_id: externalId,
            email: "shared@example.com",
          }),
        }),
      )
    }
    const found = await sync.findContact(77, "shared@example.com")
    expect(found?.external_id).toBe("a")
    expect(sync.logs.at(-1)).toContain("Multiple Intercom contacts found")
  })

  test("escalation: conversation with Idempotency-Key replays; the escalation attribute and the transcript land", async () => {
    const { sync, runtime, send } = harness()
    const contact = await sync.createContact(payload(1652, "ada@example.com"))
    const a = await sync.createConversation({
      intercomContactId: contact.id,
      body: "I need a human",
      idempotencyKey: "esc-1",
    })
    const b = await sync.createConversation({
      intercomContactId: contact.id,
      body: "I need a human",
      idempotencyKey: "esc-1",
    })
    expect(b).toEqual(a)
    expect(runtime.instance().conversations()).toHaveLength(1)
    await expect(
      sync.createConversation({
        intercomContactId: contact.id,
        body: "different",
        idempotencyKey: "esc-1",
      }),
    ).rejects.toThrow("409")
    expect(
      runtime.instance().state.conversations.get(a.intercomConversationId)?.custom_attributes,
    ).toEqual({
      chatbot_escalation: true,
    })
    await sync.attachFileToConversation({
      intercomConversationId: a.intercomConversationId,
      intercomContactId: contact.id,
      filename: "transcript.txt",
      content: "user: hi\nbot: hello",
      contentType: "text/plain",
    })
    const got = (await (
      await send(
        new Request(`${API}/conversations/${a.intercomConversationId}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      )
    ).json()) as {
      conversation_parts: {
        conversation_parts: { attachments: { name: string; filesize: number }[] }[]
      }
    }
    expect(got.conversation_parts.conversation_parts[0]?.attachments).toEqual([
      expect.objectContaining({ name: "transcript.txt", filesize: 19, content_type: "text/plain" }),
    ])
    expect(await sync.checkConnection()).toBe(true)
  })

  test("sync writes are refused when FEATURE_INTERCOM_SYNC_ENABLED is off (reads still work)", async () => {
    const { send } = harness()
    const off = new IntercomApiAdapter(API, { accessToken: TOKEN, syncEnabled: false }, send)
    await expect(off.createContact(payload(1, "a@example.com"))).rejects.toThrow("refused")
    expect(await off.findContact(1, "a@example.com")).toBeNull()
  })

  test("undefined custom attributes are rejected when the workspace defines its own", async () => {
    const { sync, admin } = harness()
    await admin("/settings", { customAttributes: ["acme_user_id"] }, "PUT")
    await expect(sync.createContact(payload(5, "five@example.com"))).rejects.toThrow(
      "does not exist",
    )
  })
})

describe("S16 acceptance: the member messaging adapter against the mock", () => {
  test("create, list, get (plaintext, ownership), reply JSON and multipart, mark read, unread count", async () => {
    const { messaging, admin } = harness()
    const created = await messaging.createConversation({
      userExternalId: "1652",
      userEmail: "ada@example.com",
      body: "Fish & chips, 2 < 3",
    })
    expect(created.state).toBe("open")
    const listed = await messaging.listConversations({ userExternalId: "1652" })
    expect(listed.conversations.map((c) => c.id)).toEqual([created.id])
    // Search results carry no conversation parts, so the preview is the plaintext source.
    expect(listed.conversations[0]?.lastMessage).toBe("Fish & chips, 2 < 3")

    const detail = await messaging.getConversation({
      conversationId: created.id,
      userExternalId: "1652",
    })
    expect(detail.messages[0]?.body).toBe("Fish & chips, 2 < 3")
    await expect(
      messaging.getConversation({ conversationId: created.id, userExternalId: "999" }),
    ).rejects.toMatchObject({
      status: 403,
    })

    const replied = await messaging.replyToConversation({
      conversationId: created.id,
      userExternalId: "1652",
      body: "Line one\nLine two",
    })
    expect(replied.messages.at(-1)?.body).toBe("Line one\nLine two")
    const withFile = await messaging.replyToConversation({
      conversationId: created.id,
      userExternalId: "1652",
      body: "See attached",
      attachments: [
        {
          name: "lab.pdf",
          contentType: "application/pdf",
          data: Buffer.from("%PDF-1.4").toString("base64"),
        },
      ],
    })
    expect(withFile.messages.at(-1)?.attachments).toEqual([
      {
        name: "lab.pdf",
        url: expect.stringMatching(/^https:\/\/downloads\.intercomcdn\.com\/i\/o\//),
        contentType: "application/pdf",
      },
    ])

    // An admin reply makes it unread for the member; marking it read clears that.
    expect(
      (
        await admin(`/conversations/${created.id}/admin-reply`, {
          adminId: "1000001",
          body: "Hi Ada",
        })
      ).status,
    ).toBe(200)
    expect(await messaging.getUnreadCount("1652")).toEqual({ count: 1 })
    await messaging.markAsRead({ conversationId: created.id, userExternalId: "1652" })
    expect(await messaging.getUnreadCount("1652")).toEqual({ count: 0 })
    // Parts are filtered to comments, source first.
    const all = await messaging.getConversation({
      conversationId: created.id,
      userExternalId: "1652",
    })
    expect(all.messages.map((m) => m.author.type)).toEqual(["user", "user", "user", "admin"])
    // The journal never holds message bodies.
    const journal = await (await admin("/requests")).text()
    expect(journal).not.toContain("Fish")
    expect(journal).not.toContain("Hi Ada")
  })

  test("404 → re-resolve the contact and retry once (contact_stale_404)", async () => {
    const { messaging, runtime } = harness()
    await messaging.createConversation({
      userExternalId: "7",
      userEmail: "seven@example.com",
      body: "hi",
    })
    runtime.applyPreset("contact_stale_404")
    const listed = await messaging.listConversations({ userExternalId: "7" })
    expect(listed.conversations).toHaveLength(1)
    // The cached contact id 404s, the cache is dropped, the id re-resolved and the search retried.
    const ops = runtime.journal.list({ namespace: "default" }).map((e) => [e.operationId, e.status])
    expect(ops.slice(-3)).toEqual([
      ["SearchConversations", 404],
      ["SearchContacts", 200],
      ["SearchConversations", 200],
    ])
  })

  test("error mapping: 429 → 429, other 4xx → 400, 5xx → throw", async () => {
    const { messaging, runtime } = harness()
    await messaging.createConversation({
      userExternalId: "8",
      userEmail: "e@example.com",
      body: "x",
    })
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    await expect(messaging.getUnreadCount("8")).rejects.toMatchObject({ status: 429 })
    runtime.applyPreset("unauthorized", "default", { count: 1 })
    await expect(messaging.getUnreadCount("9")).rejects.toMatchObject({ status: 400 })
    runtime.applyPreset("server_error", "default", { count: 1 })
    const failure = await messaging.getUnreadCount("8").catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(HttpException)
    expect(
      await messaging
        .getConversation({ conversationId: "404404", userExternalId: "8" })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(NotFoundException)
  })

  test("admin inbox: cursor pagination over >150 conversations, sort, filters, 503s", async () => {
    const { messaging, runtime } = harness()
    await messaging.createConversation({
      userExternalId: "100",
      userEmail: "u100@example.com",
      body: "first",
    })
    const contactId = await messaging.resolveIntercomContactId("100")
    const api = runtime.instance()
    const conversation = api.conversations()[0]
    // Clone enough conversations to need two pages of 150.
    for (let i = 0; i < 160; i++) {
      runtime.clock.advance(1_000)
      await messaging.createConversation({
        userExternalId: "100",
        userEmail: "u100@example.com",
        body: `m${i}`,
      })
    }
    expect(conversation?.contactId).toBe(contactId)
    const inbox = await messaging.listAdminConversations({ state: "open" })
    expect(inbox.pagesFetched).toBe(2)
    expect(inbox.conversations).toHaveLength(161)
    // sort_field updated_at, descending: newest first.
    expect(inbox.conversations[0]?.lastMessage).toBe("m159")
    expect(inbox.conversations.at(-1)?.lastMessage).toBe("first")
    // pageLimit stops early and hands back the cursor.
    const limited = await messaging.listAdminConversations({ state: "open", pageLimit: 1 })
    expect(limited.conversations).toHaveLength(150)
    expect(typeof limited.nextCursor).toBe("string")
    const rest = await messaging.listAdminConversations({
      state: "open",
      cursor: limited.nextCursor as string,
    })
    expect(rest.conversations).toHaveLength(11)
    // Filters: AND of member + state; closed conversations drop out of the open inbox.
    await messaging.adminCloseConversation({
      conversationId: conversation?.id as string,
      adminId: "1000001",
    })
    expect(
      (await messaging.listAdminConversations({ userExternalId: "100", state: "closed" }))
        .conversations,
    ).toHaveLength(1)
    expect(
      (await messaging.listAdminConversations({ userExternalId: "100", state: "any" }))
        .conversations,
    ).toHaveLength(161)
    runtime.applyPreset("search_unavailable", "default", { count: 1 })
    await expect(messaging.listAdminConversations({ state: "open" })).rejects.toMatchObject({
      status: 503,
    })
    runtime.applyPreset("repeated_cursor", "default", { count: 2 })
    await expect(messaging.listAdminConversations({ state: "open" })).rejects.toMatchObject({
      status: 503,
      message: "Intercom conversation pagination did not advance",
    })
  })

  test("admin reply / close / reopen and admin lookup by email", async () => {
    const { messaging } = harness()
    const created = await messaging.createConversation({
      userExternalId: "5",
      userEmail: "five@example.com",
      body: "hey",
    })
    const adminId = await messaging.resolveAdminIdByEmail("Support@Mock.Intercom.Local")
    expect(adminId).toBe("1000001")
    expect(await messaging.resolveAdminIdByEmail("nobody@example.com")).toBeNull()
    const replied = await messaging.adminReply({
      conversationId: created.id,
      adminId: adminId as string,
      body: "<p>We're on it</p>",
    })
    expect(replied.messages.at(-1)).toMatchObject({
      body: "We're on it",
      author: { type: "admin", name: "Mock Support" },
    })
    expect(replied.userExternalId).toBe("5")
    // An internal note is not a comment: filtered out of the thread.
    const noted = await messaging.adminReply({
      conversationId: created.id,
      adminId: "1000001",
      body: "note",
      messageType: "note",
    })
    expect(noted.messages).toHaveLength(2)
    expect(
      (await messaging.adminCloseConversation({ conversationId: created.id, adminId: "1000001" }))
        .state,
    ).toBe("closed")
    expect(
      (await messaging.adminReopenConversation({ conversationId: created.id, adminId: "1000001" }))
        .state,
    ).toBe("open")
    await messaging.adminMarkAsRead(created.id)
    await expect(
      messaging.adminReply({ conversationId: created.id, adminId: "123", body: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe("S16 acceptance: webhooks to the backend and the EMR", () => {
  test("admin reply fires conversation.admin.replied to both receivers, signed and verified; duplicates dedupe", async () => {
    const { messaging, admin, flush, runtime } = harness()
    const created = await messaging.createConversation({
      userExternalId: "1652",
      userEmail: "ada@example.com",
      body: "hello",
    })
    const backend = new BackendWebhookReceiver(SECRET, messaging)
    const emr = new EmrWebhookReceiver(SECRET, [
      { id: 1652, email: "ada@example.com", medplumUserId: "mp-1652" },
    ])
    runtime.applyPreset("webhook_duplicate", "default", { count: 1 })
    await admin(`/conversations/${created.id}/admin-reply`, {
      adminId: "1000001",
      body: "Your results are in",
    })
    const deliveries = await flush()
    expect(deliveries.map((d) => d.url).sort()).toEqual([
      BACKEND_HOOK,
      BACKEND_HOOK,
      EMR_HOOK,
      EMR_HOOK,
    ])
    for (const delivery of deliveries) {
      // Independent HMAC-SHA1 over the raw body.
      expect(delivery.signature).toBe(
        `sha1=${createHmac("sha1", SECRET).update(delivery.body).digest("hex")}`,
      )
      const parsed = JSON.parse(delivery.body) as {
        type: string
        topic: string
        data: { type: string }
      }
      expect(parsed).toMatchObject({
        type: "notification_event",
        topic: "conversation.admin.replied",
        data: { type: "notification_event_data" },
      })
    }
    const toBackend = deliveries.filter((d) => d.url === BACKEND_HOOK)
    const outcomes = []
    for (const d of toBackend) outcomes.push(await backend.handle(d.signature, d.body))
    expect(outcomes.map((o) => o.body)).toEqual([{ status: "ok" }, { status: "duplicate" }])
    expect(backend.notifications).toEqual([
      { userId: 1652, conversationId: created.id, preview: "Your results are in" },
    ])
    const toEmr = deliveries.filter((d) => d.url === EMR_HOOK)
    const emrOutcomes = []
    for (const d of toEmr) emrOutcomes.push(await emr.handle(d.signature, d.body))
    expect(emrOutcomes.map((o) => o.message)).toEqual([
      "Webhook processed successfully",
      "Message already being processed or already processed",
    ])
    expect(emr.notifications).toEqual([
      { userId: 1652, conversationId: created.id, message: "Your results are in", title: "hello" },
    ])
  })

  test("the webhook's part timestamps are wall-clock, so the EMR's 5-minute check passes with an advanced mock clock", async () => {
    const { messaging, admin, flush, runtime } = harness()
    const created = await messaging.createConversation({
      userExternalId: "3",
      userEmail: "t@example.com",
      body: "hi",
    })
    runtime.clock.advance(86_400_000)
    await admin(`/conversations/${created.id}/admin-reply`, { body: "a day later (mock clock)" })
    const [delivery] = (await flush()).filter((d) => d.url === EMR_HOOK)
    const emr = new EmrWebhookReceiver(SECRET, [
      { id: 3, email: "t@example.com", medplumUserId: "mp" },
    ])
    expect((await emr.handle(delivery?.signature ?? null, delivery?.body ?? "")).statusCode).toBe(
      200,
    )
    // A tampered body fails verification in both receivers.
    const tampered = (delivery?.body ?? "").replace("mock clock", "tampered!!")
    expect((await emr.handle(delivery?.signature ?? null, tampered)).statusCode).toBe(401)
    const backend = new BackendWebhookReceiver(SECRET, messaging)
    expect((await backend.handle(delivery?.signature ?? null, tampered)).status).toBe(401)
    expect((await backend.handle(null, delivery?.body ?? "")).status).toBe(401)
  })

  test("close and open (API and admin plane) fire conversation.admin.closed / opened; notes and user replies do not fire", async () => {
    const { messaging, admin, flush } = harness()
    const created = await messaging.createConversation({
      userExternalId: "4",
      userEmail: "f@example.com",
      body: "hi",
    })
    await messaging.replyToConversation({
      conversationId: created.id,
      userExternalId: "4",
      body: "more",
    })
    await messaging.adminReply({
      conversationId: created.id,
      adminId: "1000001",
      body: "internal",
      messageType: "note",
    })
    expect(await flush()).toEqual([])
    await messaging.adminCloseConversation({ conversationId: created.id, adminId: "1000001" })
    await admin(`/conversations/${created.id}/open`, {})
    const topics = (await flush())
      .filter((d) => d.url === BACKEND_HOOK)
      .map(
        (d) =>
          JSON.parse(d.body) as { topic: string; data: { item: { id: string; state: string } } },
      )
    expect(topics.map((t) => [t.topic, t.data.item.id, t.data.item.state])).toEqual([
      ["conversation.admin.closed", created.id, "closed"],
      ["conversation.admin.opened", created.id, "open"],
    ])
  })

  test("admin-initiated conversations reach the EMR's external_id path", async () => {
    const { sync, admin, flush } = harness()
    await sync.createContact(payload(2024, "adm@example.com"))
    expect(
      (await admin("/conversations", { externalId: "2024", body: "Welcome aboard!" })).status,
    ).toBe(201)
    const [delivery] = (await flush()).filter((d) => d.url === EMR_HOOK)
    const emr = new EmrWebhookReceiver(SECRET, [
      { id: 2024, email: "other@example.com", medplumUserId: "mp" },
    ])
    expect((await emr.handle(delivery?.signature ?? null, delivery?.body ?? "")).statusCode).toBe(
      200,
    )
    expect(emr.notifications[0]).toMatchObject({ userId: 2024, message: "Welcome aboard!" })
  })
})

describe("contract", () => {
  test("auth, Intercom-Version, namespaces by token, presets registered", async () => {
    const { send, admin } = harness()
    expect((await send(new Request(`${API}/me`))).status).toBe(401)
    const badVersion = await send(
      new Request(`${API}/me`, {
        headers: { authorization: `Bearer ${TOKEN}`, "intercom-version": "banana" },
      }),
    )
    expect(badVersion.status).toBe(400)
    await admin("/credentials", { credentials: { "tok-a": "a", "tok-b": "b" } }, "PUT")
    const a = new IntercomMessagingAdapter(API, "tok-a", send)
    const b = new IntercomMessagingAdapter(API, "tok-b", send)
    await a.createConversation({ userExternalId: "1", userEmail: "one@example.com", body: "hi" })
    expect((await a.listConversations({ userExternalId: "1" })).conversations).toHaveLength(1)
    expect((await b.listConversations({ userExternalId: "1" })).conversations).toHaveLength(0)
    // GET /contacts/{id}: what the admin inbox's contact enrichment reads.
    const contactId = await a.resolveIntercomContactId("1")
    const contact = (await (
      await send(
        new Request(`${API}/contacts/${contactId}`, { headers: { authorization: "Bearer tok-a" } }),
      )
    ).json()) as { name: string | null; email: string; external_id: string }
    expect(contact).toMatchObject({ name: null, email: "one@example.com", external_id: "1" })
    expect(Object.keys(INTERCOM_PRESETS)).toEqual(
      expect.arrayContaining([
        "rate_limited",
        "server_error",
        "contact_stale_404",
        "search_unavailable",
        "repeated_cursor",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("the adapter works against the node server; webhooks reach a Bun.serve sink signed", async () => {
    const received: { signature: string | null; body: string; path: string }[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          signature: request.headers.get("x-hub-signature"),
          body: await request.text(),
          path: new URL(request.url).pathname,
        })
        return new Response(null, { status: 201 })
      },
    })
    const server = await createServer({
      webhooks: {
        urls: [
          `http://127.0.0.1:${sink.port}/messaging/webhook`,
          `http://127.0.0.1:${sink.port}/v1/webhooks/intercom`,
        ],
        secret: SECRET,
      },
    })
    try {
      const messaging = new IntercomMessagingAdapter(server.url, TOKEN, (r) => fetch(r))
      const created = await messaging.createConversation({
        userExternalId: "42",
        userEmail: "h@example.com",
        body: "over http",
      })
      await messaging.replyToConversation({
        conversationId: created.id,
        userExternalId: "42",
        body: "with a file",
        attachments: [
          {
            name: "a.png",
            contentType: "image/png",
            data: Buffer.from([1, 2, 3]).toString("base64"),
          },
        ],
      })
      await messaging.adminReply({ conversationId: created.id, adminId: "1000001", body: "answer" })
      const deadline = Date.now() + 3_000
      while (received.length < 2 && Date.now() < deadline) await Bun.sleep(25)
      expect(received.map((r) => r.path).sort()).toEqual([
        "/messaging/webhook",
        "/v1/webhooks/intercom",
      ])
      for (const r of received) {
        expect(r.signature).toBe(`sha1=${createHmac("sha1", SECRET).update(r.body).digest("hex")}`)
      }
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^intercom@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
