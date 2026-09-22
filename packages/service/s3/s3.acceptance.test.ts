import { describe, expect, test } from "bun:test"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { S3API } from "./src/index.js"
import { createRuntime } from "./src/runtime.js"

const xmlCode = async (response: Response) =>
  /<Code>([^<]+)<\/Code>/.exec(await response.text())?.[1]

describe("S3 contract", () => {
  test("canonical errors, ranges, idempotent deletion and namespace isolation", async () => {
    const runtime = createRuntime()
    expect(await xmlCode(await runtime.fetch(new Request("http://mock/missing/key")))).toBe(
      "NoSuchBucket",
    )
    await runtime.fetch(new Request("http://mock/data", { method: "PUT" }))
    await runtime.fetch(new Request("http://mock/data/key", { method: "PUT", body: "abcdef" }))
    expect(
      (
        await runtime.fetch(
          new Request("http://mock/data/key", { headers: { range: "bytes=2-4" } }),
        )
      ).status,
    ).toBe(206)
    expect(
      (
        await runtime.fetch(
          new Request("http://mock/data/key", { headers: { range: "bytes=99-100" } }),
        )
      ).status,
    ).toBe(416)
    expect(
      (await runtime.fetch(new Request("http://mock/data/absent", { method: "DELETE" }))).status,
    ).toBe(204)
    const isolated = await runtime.fetch(
      new Request("http://mock/data/key", { headers: { "x-mockingbird-namespace": "other" } }),
    )
    expect(await xmlCode(isolated)).toBe("NoSuchBucket")
  })

  test("presigned signatures bind method and expire against the injected clock", async () => {
    let now = Date.now()
    const api = new S3API({ now: () => now })
    await api.fetch(new Request("http://mock/uploads", { method: "PUT" }))
    const client = new S3Client({
      endpoint: "http://mock",
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    const signed = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: "uploads", Key: "signed.txt" }),
      { expiresIn: 60 },
    )
    expect((await api.fetch(new Request(signed, { method: "GET" }))).status).toBe(403)
    expect(await xmlCode(await api.fetch(new Request(signed, { method: "GET" })))).toBe(
      "SignatureDoesNotMatch",
    )
    now += 61_000
    expect(
      await xmlCode(await api.fetch(new Request(signed, { method: "PUT", body: "late" }))),
    ).toBe("AccessDenied")
    client.destroy()
  })

  test("object events are captured and retried by the shared webhook hub", async () => {
    const attempts: string[] = []
    const runtime = createRuntime({
      webhooks: {
        endpoints: [{ url: "https://sink.test/s3", events: ["*"] }],
        retryDelaysMs: [0],
        fetch: async (request) => {
          attempts.push(await request.text())
          return new Response(null, { status: 204 })
        },
      },
    })
    await runtime.fetch(new Request("http://mock/events", { method: "PUT" }))
    await runtime.fetch(new Request("http://mock/events/a.txt", { method: "PUT", body: "a" }))
    await runtime.webhooks.idle()
    expect(attempts).toHaveLength(1)
    expect(JSON.parse(attempts[0] as string).Records[0].eventName).toBe("ObjectCreated:Put")
    expect(runtime.webhooks.deliveries()).toHaveLength(1)
  })
})
