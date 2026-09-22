import { describe, expect, test } from "bun:test"
import { createServer, DEFAULT_PORT, serveTarget } from "./src/server.js"
import { AhaServiceConsumer, bloodworkOrderRequest, guardAllows } from "./test/consumer.js"

const SECRET = "aha-webhook-secret"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }

describe("served over HTTP", () => {
  test("the consumer works against the node server, and autoSchedule fires the webhook on its own", async () => {
    const received: Record<string, unknown>[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (guardAllows(request.headers, SECRET)) {
          received.push((await request.json()) as Record<string, unknown>)
        }
        return Response.json({ success: true, message: "Webhook received" }, { status: 201 })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}/bloodwork/aha-webhook`, secret: SECRET },
      settings: {
        credentials: [{ apiKey: "geviti_aha_http", apiSecret: "http-secret" }],
        autoSchedule: { afterMs: 50 },
      },
    })
    try {
      const consumer = new AhaServiceConsumer(
        { apiUrl: server.url, apiKey: "geviti_aha_http", apiSecret: "http-secret" },
        (r) => fetch(r),
      )
      const placed = await consumer.createOrUpdateOrder(
        bloodworkOrderRequest(
          5,
          {
            id: 1,
            firstName: "Ada",
            lastName: "Lovelace",
            sex: "F",
            dob: "1985-12-10",
            phoneNumber: "6025550142",
            email: "ada@example.com",
          },
          { line1: "1 Main St", city: "Phoenix", state: "AZ", zip: "85004" },
          { firstName: "Grace", lastName: "Hopper", npiNumber: "1234567893" },
          [{ test_code: "CMP", test_description: "CMP" }],
        ),
      )
      expect(placed.success).toBe(true)
      const deadline = Date.now() + 3_000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(received[0]).toMatchObject({ status: "Scheduled", partnerOrderId: "GV-5" })
      expect(typeof received[0]?.scheduleServiceTime).toBe("string")
      expect(received[0]?.scheduleServiceTimeZone).toBe("America/New_York")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^aha@/)
      expect(((await health.json()) as { webhooks: string }).webhooks).toBe("on")
    } finally {
      await server.close()
      sink.stop(true)
    }
  })

  test("the serve target validates its flags and uses port 8799", () => {
    expect(DEFAULT_PORT).toBe(8799)
    expect(serveTarget.defaultPort).toBe(8799)
    expect(() => serveTarget.create({ envelope: "json" }, COMMON)).toThrow("--envelope")
    expect(() => serveTarget.create({ "api-secret": "s" }, COMMON)).toThrow("--api-key")
    const runtime = serveTarget.create(
      { envelope: "wrapped", "api-key": "k", "api-secret": "s", "auto-schedule": "1000" },
      COMMON,
    ) as unknown as { instance(): { state: { current(): unknown } }; stop(): void }
    expect(runtime.instance().state.current()).toMatchObject({
      envelope: "wrapped",
      credentials: [{ apiKey: "k", apiSecret: "s" }],
      autoSchedule: { afterMs: 1000 },
    })
    runtime.stop()
  })
})
