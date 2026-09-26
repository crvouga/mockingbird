import { describe, expect, test } from "bun:test"
import { createServer, DEFAULT_PORT, serveTarget } from "./src/server.js"
import { DailyEmrConsumer, DailyWebhookReceiver, FakeS3, readTranscript } from "./test/consumer.js"

const SECRET = "daily-webhook-secret"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }

describe("served over HTTP", () => {
  test("book over node:http; a session writes to an HTTP S3 and the signed webhook reaches the EMR receiver", async () => {
    const s3 = new FakeS3()
    const s3Server = Bun.serve({ port: 0, fetch: s3.fetch })
    const outcomes: { status: number; body: Record<string, unknown> }[] = []
    let receiver: DailyWebhookReceiver | undefined
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const raw = Buffer.from(await request.arrayBuffer())
        const outcome = (receiver as DailyWebhookReceiver).receive(raw, request.headers)
        outcomes.push(outcome)
        return Response.json(outcome.body, { status: outcome.status })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}/v1/webhooks/daily`, secret: SECRET },
      transcripts: { endpoint: `http://127.0.0.1:${s3Server.port}`, bucket: "emr-transcripts" },
      settings: { roomUrlBase: "https://served.daily.test/" },
    })
    try {
      const emr = new DailyEmrConsumer(
        { apiKey: "k", baseUrl: `${server.url}/v1`, roomBaseUrl: "https://served.daily.test/" },
        (r) => fetch(r),
      )
      const meeting = await emr.addVideoMeetingToAppointment({
        start: "2030-01-01T10:00:00Z",
        end: "2030-01-01T10:30:00Z",
        providerId: "prac-1",
        providerName: "Dr Hopper",
      })
      expect(meeting.roomUrl).toBe(`https://served.daily.test/${meeting.roomId}`)
      receiver = new DailyWebhookReceiver(SECRET, [
        {
          roomName: meeting.roomId,
          appointmentId: "a1",
          role: "provider",
          fhirResourceId: "Practitioner/prac-1",
        },
        {
          roomName: meeting.roomId,
          appointmentId: "a1",
          role: "member",
          fhirResourceId: "Patient/pat-1",
        },
      ])
      const session = await fetch(`${server.url}/__admin/rooms/${meeting.roomId}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participants: [{ userId: "prac-1" }, { userId: "pat-1" }],
          durationSec: 600,
          sessionId: "s-http",
        }),
      })
      expect(session.status).toBe(200)
      const deadline = Date.now() + 3_000
      while (outcomes.length < 2 && Date.now() < deadline) await Bun.sleep(25)
      expect(outcomes.map((o) => o.status)).toEqual([200, 200])
      expect(receiver.jobs[0]).toMatchObject({ sessionId: "s-http", callDurationSeconds: 600 })
      expect(s3.rejected).toEqual([])
      expect(
        readTranscript((b, k) => s3.get(b, k), "emr-transcripts", meeting.roomId, "s-http"),
      ).toHaveLength(12)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^daily@/)
    } finally {
      await server.close()
      sink.stop(true)
      s3Server.stop(true)
    }
  })

  test("the serve target validates its flags and uses port 8800", () => {
    expect(DEFAULT_PORT).toBe(8800)
    expect(() => serveTarget.create({ "s3-endpoint": "http://x" }, COMMON)).toThrow("--s3-bucket")
    const runtime = serveTarget.create(
      { "api-key": "k", "domain-id": "d", "room-url-base": "https://x.daily.co/" },
      COMMON,
    ) as unknown as { instance(): { state: { current(): unknown } } }
    expect(runtime.instance().state.current()).toMatchObject({
      apiKeys: ["k"],
      domainId: "d",
      roomUrlBase: "https://x.daily.co/",
    })
  })
})
