/**
 * The official `resend` SDK at the version our backend pins (4.8.0), with `RESEND_BASE_URL`
 * pointed at the served mock before the SDK is imported (it reads the variable once, at module
 * load: see test/stack.ts), and the official `svix` verifier (1.41.0) on the inbound webhook.
 */
import { describe, expect, test } from "bun:test"
import { Webhook } from "svix"
import { admin, isolatedKey, sharedStack } from "./test/stack.js"

const FROM = "Acme Platform <no-reply@acme.example>"

const client = async (label: string) => {
  const { Resend, resend } = await sharedStack()
  const { key, namespace } = await isolatedKey(label)
  return { sdk: new Resend(key), namespace, runtime: resend.runtime }
}

describe("resend@4.8.0 against the mock", () => {
  test("emails.send returns {data: {id}, error: null}; emails.get reads it back", async () => {
    const { sdk, namespace } = await client("send")
    const sent = await sdk.emails.send({
      from: FROM,
      to: ["Ada Lovelace <Ada@Example.com>"],
      subject: "Hello",
      html: '<p>Hi <a href="https://app.test/x">there</a></p>',
      text: "Hi there",
      replyTo: "care@acme.example",
      tags: [{ name: "category", value: "welcome" }],
      headers: { "X-Entity-Ref-ID": "abc" },
      attachments: [{ filename: "a.txt", content: Buffer.from("hello") }],
    })
    expect(sent.error).toBeNull()
    const id = sent.data?.id as string
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    const got = await sdk.emails.get(id)
    expect(got.data).toMatchObject({
      object: "email",
      id,
      to: ["Ada Lovelace <Ada@Example.com>"],
      from: FROM,
      subject: "Hello",
      reply_to: ["care@acme.example"],
      last_event: "delivered",
    })
    const outbox = (await (await admin("/outbox?to=ada@example.com", namespace)).json()) as {
      messages: { id: string; attachments: { filename: string; size: number }[] }[]
    }
    expect(outbox.messages.map((m) => m.id)).toEqual([id])
    expect(outbox.messages[0]?.attachments).toEqual([
      { filename: "a.txt", contentType: null, size: 5 },
    ] as never)
  })

  test("send_422: the SDK returns {error: {name: 'validation_error', statusCode: 422}}", async () => {
    const { sdk, namespace, runtime } = await client("send-422")
    runtime.applyPreset("send_422", namespace, { count: 1 })
    const result = await sdk.emails.send({ from: FROM, to: "a@b.co", subject: "x", text: "x" })
    expect(result.data).toBeNull()
    expect(result.error).toMatchObject({ name: "validation_error", statusCode: 422 })
    expect(typeof result.error?.message).toBe("string")
  })

  test("real validation errors come back in Resend's shape", async () => {
    const { sdk } = await client("validation")
    const badTo = await sdk.emails.send({
      from: FROM,
      to: "not-an-address",
      subject: "x",
      text: "x",
    })
    expect(badTo.error).toMatchObject({ name: "validation_error", statusCode: 422 })
    expect(badTo.error?.message).toContain("Invalid `to` field")
    const noSubject = await sdk.emails.send({ from: FROM, to: "a@b.co", text: "x" } as never)
    expect(noSubject.error).toMatchObject({
      name: "missing_required_field",
      statusCode: 422,
      message: "Missing `subject` field.",
    })
    const noBody = await sdk.emails.send({ from: FROM, to: "a@b.co", subject: "x" } as never)
    expect(noBody.error?.name).toBe("missing_required_field")
    const badTag = await sdk.emails.send({
      from: FROM,
      to: "a@b.co",
      subject: "x",
      text: "x",
      tags: [{ name: "category", value: "has spaces" }],
    })
    expect(badTag.error?.message).toContain("Invalid `tags` field")
  })

  test("send_429 and send_500 pass through as {name, statusCode}", async () => {
    const { sdk, namespace, runtime } = await client("send-5xx")
    runtime.applyPreset("send_429", namespace, { count: 1 })
    const limited = await sdk.emails.send({ from: FROM, to: "a@b.co", subject: "x", text: "x" })
    expect(limited.error).toMatchObject({ name: "rate_limit_exceeded", statusCode: 429 })
    runtime.applyPreset("send_500", namespace, { count: 1 })
    const failed = await sdk.emails.send({ from: FROM, to: "a@b.co", subject: "x", text: "x" })
    expect(failed.error).toMatchObject({ name: "internal_server_error", statusCode: 500 })
  })

  test("non_json_500: the SDK maps a non-JSON body to application_error", async () => {
    const { sdk, namespace, runtime } = await client("non-json")
    runtime.applyPreset("non_json_500", namespace, { count: 1 })
    const result = await sdk.emails.send({ from: FROM, to: "a@b.co", subject: "x", text: "x" })
    expect(result).toEqual({
      data: null,
      error: {
        name: "application_error",
        message:
          "Internal server error. We are unable to process your request right now, please try again later.",
      },
    } as never)
  })

  test("network_drop: the SDK reports 'Unable to fetch data' and never throws", async () => {
    const { sdk, namespace, runtime } = await client("drop")
    runtime.applyPreset("network_drop", namespace, { count: 1 })
    const result = await sdk.emails.send({ from: FROM, to: "a@b.co", subject: "x", text: "x" })
    expect(result).toEqual({
      data: null,
      error: {
        name: "application_error",
        message: "Unable to fetch data. The request could not be resolved.",
      },
    } as never)
    expect(runtime.instance(namespace).sent()).toEqual([])
  })

  test("Idempotency-Key: a replay returns the same id; a different payload is a 409", async () => {
    const { sdk, namespace, runtime } = await client("idempotency")
    const payload = { from: FROM, to: "a@b.co", subject: "Receipt", text: "Thanks" }
    const first = await sdk.emails.send(payload, { idempotencyKey: "order_42_receipt" })
    const again = await sdk.emails.send(payload, { idempotencyKey: "order_42_receipt" })
    expect(again.data?.id).toBe(first.data?.id as string)
    expect(runtime.instance(namespace).sent()).toHaveLength(1)
    const changed = await sdk.emails.send(
      { ...payload, subject: "Different" },
      { idempotencyKey: "order_42_receipt" },
    )
    expect(changed.error).toMatchObject({ name: "invalid_idempotent_request", statusCode: 409 })
    const tooLong = await sdk.emails.send(payload, { idempotencyKey: "k".repeat(257) })
    expect(tooLong.error).toMatchObject({ name: "invalid_idempotency_key", statusCode: 400 })
  })

  test("the inbound email.received webhook verifies with the official svix package", async () => {
    const { namespace } = await client("svix")
    const secret = `whsec_${Buffer.from("resend-inbound-test-secret-bytes").toString("base64")}`
    const received: { headers: Record<string, string>; body: string }[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        })
        return Response.json({ ok: true })
      },
    })
    try {
      const { resend } = await sharedStack()
      await fetch(`${resend.url}/__admin/webhook-endpoints`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
        body: JSON.stringify({
          endpoints: [{ url: `http://127.0.0.1:${sink.port}/messaging/inbound/email`, secret }],
        }),
      })
      const created = await admin("/inbound", namespace, {
        from: "Patient <patient@example.com>",
        to: "care+tok123@care.acme.example",
        subject: "Question",
        text: "Hello care team",
      })
      expect(created.status).toBe(201)
      await resend.runtime.webhooks.idle()
      expect(received).toHaveLength(1)
      const delivery = received[0] as { headers: Record<string, string>; body: string }
      const verified = new Webhook(secret).verify(delivery.body, delivery.headers) as {
        type: string
        data: { email_id: string; to: string[] }
      }
      expect(verified.type).toBe("email.received")
      expect(verified.data.to).toEqual(["care+tok123@care.acme.example"])
      expect(() =>
        new Webhook(`whsec_${Buffer.from("wrong").toString("base64")}`).verify(
          delivery.body,
          delivery.headers,
        ),
      ).toThrow()
    } finally {
      sink.stop(true)
    }
  })
})
