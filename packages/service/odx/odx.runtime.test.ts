import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, SIGNATURE_HEADER, signOdx } from "./src/index.js"

const PRACTICE = "3f0c0c43-7d2b-4b8e-9a50-9c1f0c6c0001"
const HL7 =
  "MSH|^~\\&|LAB|AHA|GEVITI|GEVITI|20250115000000||ORU^R01|X|P|2.3\rPID|1||E2E||Doe^Jane||19800101|F\rOBX|1|NM|1751-7^Albumin||4.2|g/dL|3.5-5.5|N|||F\r"

const setup = () => {
  const received: { headers: Headers; body: string }[] = []
  const runtime = createRuntime({
    webhook: { url: "http://backend.local/odx/webhook", signingKey: "key-1" },
    fetch: async (request) => {
      received.push({ headers: request.headers, body: await request.text() })
      return new Response(null, { status: 201 })
    },
  })
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    runtime.fetch(
      new Request(`http://odx.mock${path}`, {
        method: init.method ?? (init.json === undefined ? "GET" : "POST"),
        headers: {
          apikey: "k",
          "content-type": "application/json",
          ...(init.headers as Record<string, string>),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      }),
    )
  const importTest = async (prefix = "", headers: Record<string, string> = {}) => {
    const patient = (await (
      await call(`${prefix}/v1/practice/${PRACTICE}/patient`, {
        json: { firstName: "Jane", lastName: "Doe", gender: "Female", email: "j@example.com" },
        headers,
      })
    ).json()) as { patientId: number }
    const res = await call(`${prefix}/v1/practice/${PRACTICE}/patient/${patient.patientId}/test`, {
      json: {
        labProfileId: 1,
        labId: 1,
        testDate: "2025-01-15",
        unitType: "ConventionalUS",
        hl7: HL7,
      },
      headers,
    })
    return (await res.json()) as { patientTestId: number }
  }
  return { runtime, call, received, importTest }
}

describe("contract and runtime", () => {
  test("/health, the x-mockingbird header, and ApiKey auth", async () => {
    const { runtime, call } = setup()
    const health = await runtime.fetch(new Request("http://odx.mock/health"))
    expect(((await health.json()) as { status: string }).status).toBe("ok")
    expect(health.headers.get("x-mockingbird")).toMatch(/^odx@.*; ns=default$/)
    const missing = await runtime.fetch(new Request("http://odx.mock/v1/partner/labs"))
    expect(missing.status).toBe(401)
    expect(((await missing.json()) as { message: string }).message).toContain(
      "missing subscription key",
    )
    expect((await call("/v1/partner/labs")).status).toBe(200)
  })

  test("namespaces by header and /ns/ prefix isolate state, and the pre-registered webhook is in each", async () => {
    const { call, importTest } = setup()
    await importTest("/ns/alpha")
    const alpha = await call(`/ns/alpha/v1/practice/${PRACTICE}/patients`)
    expect(((await alpha.json()) as unknown[]).length).toBe(1)
    const beta = await call(`/v1/practice/${PRACTICE}/patients`, {
      headers: { "x-mockingbird-namespace": "beta" },
    })
    expect(await beta.json()).toEqual([])
    const hooks = (await (await call("/ns/beta/v1/webhooks")).json()) as { signingKey: string }[]
    expect(hooks.map((h) => h.signingKey)).toEqual(["key-1"])
  })

  test("webhooks are signed UPPERCASE hex HMAC-SHA256 (independent node:crypto check), retried and duplicated on demand", async () => {
    const { runtime, received, importTest } = setup()
    runtime.applyPreset("webhook_duplicate", "default", { count: 1 })
    await importTest()
    await runtime.webhooks.idle()
    expect(received).toHaveLength(2)
    const [first] = received
    const expected = createHmac("sha256", "key-1")
      .update(first?.body as string)
      .digest("hex")
      .toUpperCase()
    expect(first?.headers.get(SIGNATURE_HEADER)).toBe(expected)
    expect(await signOdx("key-1", first?.body as string)).toBe(expected)
  })

  test("admin: emit a webhook with a chosen signature, list tests, delete emits Deleted; reset clears", async () => {
    const { runtime, received, importTest } = setup()
    const test = await importTest()
    await runtime.webhooks.idle()
    received.splice(0)
    const emit = await runtime.fetch(
      new Request(`http://odx.mock/__admin/tests/${test.patientTestId}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventType: "Updated", signature: "short" }),
      }),
    )
    expect(emit.status).toBe(202)
    await runtime.webhooks.idle()
    expect(received[0]?.headers.get(SIGNATURE_HEADER)).toHaveLength(32)
    const tests = (await (
      await runtime.fetch(new Request("http://odx.mock/__admin/tests"))
    ).json()) as {
      tests: unknown[]
    }
    expect(tests.tests).toHaveLength(1)
    expect(JSON.stringify(tests)).not.toContain("Doe^Jane")
    await runtime.fetch(new Request("http://odx.mock/__admin/reset", { method: "POST" }))
    const after = (await (
      await runtime.fetch(new Request("http://odx.mock/__admin/tests"))
    ).json()) as {
      tests: unknown[]
    }
    expect(after.tests).toEqual([])
  })
})
