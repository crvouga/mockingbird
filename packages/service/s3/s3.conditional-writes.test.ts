import { describe, expect, test } from "bun:test"
import { S3API } from "./src/index.js"

const url = "http://mock/objects/conditional.txt"
const bodies = ["first concurrent writer", "second concurrent writer"]

describe("concurrent conditional PutObject", () => {
  for (const condition of ["if-none-match", "if-match"] as const) {
    for (const checked of [false, true]) {
      test(`${condition} permits one streamed writer${checked ? " with SHA-256" : ""}`, async () => {
        const api = new S3API({ buckets: ["objects"] })
        let expected = "*"
        if (condition === "if-match") {
          const initial = await api.fetch(new Request(url, { method: "PUT", body: "initial" }))
          expect(initial.status).toBe(200)
          const etag = initial.headers.get("etag")
          if (!etag) throw new Error("Initial object has no ETag")
          expected = etag
        }
        let readers = 0
        let release = () => {}
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const requests = await Promise.all(
          bodies.map(async (value) => {
            const bytes = new TextEncoder().encode(value)
            const headers = new Headers({ [condition]: expected })
            headers.set("content-length", String(bytes.length))
            if (checked) {
              const digest = await crypto.subtle.digest("SHA-256", bytes)
              headers.set(
                "x-amz-checksum-sha256",
                btoa(String.fromCharCode(...new Uint8Array(digest))),
              )
            }
            const body = new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  readers++
                  if (readers === bodies.length) release()
                  await gate
                  controller.enqueue(bytes)
                  controller.close()
                },
              },
              { highWaterMark: 0 },
            )
            const init = { method: "PUT", headers, body, duplex: "half" }
            return new Request(url, init)
          }),
        )
        const responses = await Promise.all(requests.map((request) => api.fetch(request)))
        expect(readers).toBe(2)
        expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
        const winnerIndex = responses.findIndex((response) => response.status === 200)
        const winner = responses[winnerIndex]
        const loser = responses.find((response) => response.status === 412)
        const winningBody = bodies[winnerIndex]
        if (!winner || !loser || winningBody === undefined)
          throw new Error("Expected one winning conditional write")
        expect(await loser.text()).toContain("<Code>PreconditionFailed</Code>")
        expect(loser.headers.get("etag")).toBe(winner.headers.get("etag"))
        const stored = await api.fetch(new Request(url))
        expect(await stored.text()).toBe(winningBody)
        expect(stored.headers.get("etag")).toBe(winner.headers.get("etag"))
      })
    }
  }
})

const sha256 = async (value: string) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    ),
  )

describe("concurrent conditional CompleteMultipartUpload", () => {
  for (const checked of [false, true]) {
    test(`if-none-match permits one completing writer${checked ? " with SHA-256" : ""}`, async () => {
      const api = new S3API({ buckets: ["objects"] })
      const key = "http://mock/objects/multipart.txt"
      const uploads = await Promise.all(
        bodies.map(async (value) => {
          const initiated = await api.fetch(
            new Request(`${key}?uploads`, {
              method: "POST",
              headers: checked ? { "x-amz-checksum-algorithm": "SHA256" } : {},
            }),
          )
          expect(initiated.status).toBe(200)
          const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await initiated.text())?.[1]
          if (!uploadId) throw new Error("Initiated upload has no UploadId")
          const bytes = new TextEncoder().encode(value)
          const checksum = checked ? await sha256(value) : undefined
          const part = await api.fetch(
            new Request(`${key}?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, {
              method: "PUT",
              headers: checksum ? { "x-amz-checksum-sha256": checksum } : {},
              body: bytes,
            }),
          )
          expect(part.status).toBe(200)
          const etag = part.headers.get("etag")
          if (!etag) throw new Error("Uploaded part has no ETag")
          return { uploadId, etag, checksum }
        }),
      )
      let readers = 0
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const responses = await Promise.all(
        uploads.map(({ uploadId, etag, checksum }) => {
          const bytes = new TextEncoder().encode(
            `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag>${
              checksum ? `<ChecksumSHA256>${checksum}</ChecksumSHA256>` : ""
            }</Part></CompleteMultipartUpload>`,
          )
          const body = new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                readers++
                if (readers === uploads.length) release()
                await gate
                controller.enqueue(bytes)
                controller.close()
              },
            },
            { highWaterMark: 0 },
          )
          const headers = new Headers({ "if-none-match": "*" })
          headers.set("content-length", String(bytes.length))
          const init = { method: "POST", headers, body, duplex: "half" }
          return api.fetch(new Request(`${key}?uploadId=${encodeURIComponent(uploadId)}`, init))
        }),
      )
      expect(readers).toBe(2)
      expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
      const winnerIndex = responses.findIndex((response) => response.status === 200)
      const loser = responses.find((response) => response.status === 412)
      const winningBody = bodies[winnerIndex]
      if (!loser || winningBody === undefined) throw new Error("Expected one winning completion")
      expect(await loser.text()).toContain("<Code>PreconditionFailed</Code>")
      const stored = await api.fetch(new Request(key))
      expect(await stored.text()).toBe(winningBody)
    })
  }
})
