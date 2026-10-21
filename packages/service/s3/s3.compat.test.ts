import { describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { Readable } from "node:stream"
import {
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createRuntime } from "./src/runtime.js"
import { createServer } from "./src/server.js"

const credentials = { fixturekey: "fixturesecret" }
const signing = { accessKeyId: "fixturekey", secretAccessKey: "fixturesecret" }
const xmlCode = async (response: Response) =>
  /<Code>([^<]+)<\/Code>/.exec(await response.text())?.[1]
const clientFor = (url: string, extra: Record<string, unknown> = {}) =>
  new S3Client({
    endpoint: url,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: signing,
    ...extra,
  })
const seeded = (extra: Record<string, unknown> = {}) =>
  createRuntime({ buckets: ["docs"], credentials, ...extra })
const put = (runtime: ReturnType<typeof createRuntime>, path: string, init: RequestInit = {}) =>
  runtime.fetch(new Request(`http://mock${path}`, { method: "PUT", ...init }))

describe("GetObject response-* overrides (#510)", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html (response-cache-control ... response-expires)
  test("presigned and SDK-signed GETs replace the stored headers", async () => {
    const server = await createServer({ buckets: ["docs"], credentials })
    const s3 = clientFor(server.url)
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: "docs",
          Key: "invoices/INV-1.pdf",
          Body: "%PDF-1.4 fake",
          ContentType: "application/pdf",
        }),
      )
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: "docs",
          Key: "invoices/INV-1.pdf",
          ResponseContentDisposition: 'attachment; filename="INV-1.pdf"',
          ResponseContentType: "application/octet-stream",
          ResponseCacheControl: "no-store",
          ResponseContentEncoding: "identity",
          ResponseContentLanguage: "en-US",
          ResponseExpires: new Date("2030-01-01T00:00:00Z"),
        }),
        { expiresIn: 60 },
      )
      const res = await fetch(url)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("application/octet-stream")
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="INV-1.pdf"')
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("content-language")).toBe("en-US")
      expect(res.headers.get("expires")).toBe("Tue, 01 Jan 2030 00:00:00 GMT")
      expect(await res.text()).toBe("%PDF-1.4 fake")
      const viaSdk = await s3.send(
        new GetObjectCommand({
          Bucket: "docs",
          Key: "invoices/INV-1.pdf",
          ResponseContentDisposition: 'attachment; filename="INV-1.pdf"',
        }),
      )
      expect(viaSdk.ContentDisposition).toBe('attachment; filename="INV-1.pdf"')
      expect(viaSdk.ContentType).toBe("application/pdf")
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: "docs", Key: "invoices/INV-1.pdf" }),
      )
      expect(head.ContentDisposition).toBeUndefined()
      expect(head.ContentType).toBe("application/pdf")
    } finally {
      s3.destroy()
      await server.close()
    }
  })

  test("overrides apply to ranged GETs and HEAD; unsigned requests cannot use them", async () => {
    const runtime = seeded()
    await put(runtime, "/docs/a.txt", {
      body: "abcdef",
      headers: { "content-type": "text/plain", "cache-control": "max-age=60" },
    })
    const signed = { authorization: "AWS4-HMAC-SHA256 Credential=fixturekey/20300101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=00" }
    const ranged = await runtime.fetch(
      new Request("http://mock/docs/a.txt?response-content-type=text%2Fcsv", {
        headers: { ...signed, range: "bytes=1-2" },
      }),
    )
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-type")).toBe("text/csv")
    expect(ranged.headers.get("cache-control")).toBe("max-age=60")
    expect(await ranged.text()).toBe("bc")
    const head = await runtime.fetch(
      new Request("http://mock/docs/a.txt?response-cache-control=no-cache", {
        method: "HEAD",
        headers: signed,
      }),
    )
    expect(head.headers.get("cache-control")).toBe("no-cache")
    const anonymous = await runtime.fetch(
      new Request("http://mock/docs/a.txt?response-content-type=text%2Fcsv"),
    )
    expect(anonymous.status).toBe(400)
    expect(await xmlCode(anonymous)).toBe("InvalidRequest")
  })
})

describe("CopyObject copy-source conditionals (#511)", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
  const setup = async () => {
    const runtime = seeded()
    const stored = await put(runtime, "/docs/raw/a.webm", { body: "v1" })
    const etag = stored.headers.get("etag") as string
    const copy = (name: string, headers: Record<string, string>) =>
      put(runtime, `/docs/final/${name}`, {
        headers: { "x-amz-copy-source": "docs/raw/a.webm", ...headers },
      })
    const exists = async (name: string) =>
      (await runtime.fetch(new Request(`http://mock/docs/final/${name}`))).status === 200
    return { runtime, etag, copy, exists }
  }

  test("a failed precondition answers 412 and copies nothing", async () => {
    const { etag, copy, exists } = await setup()
    const wrong = await copy("if-match", {
      "x-amz-copy-source-if-match": '"00000000000000000000000000000000"',
    })
    expect(wrong.status).toBe(412)
    expect(await xmlCode(wrong)).toBe("PreconditionFailed")
    const same = await copy("if-none-match", { "x-amz-copy-source-if-none-match": etag })
    expect(same.status).toBe(412)
    const old = await copy("if-unmodified-since", {
      "x-amz-copy-source-if-unmodified-since": new Date(0).toUTCString(),
    })
    expect(old.status).toBe(412)
    const future = await copy("if-modified-since", {
      "x-amz-copy-source-if-modified-since": new Date("2099-01-01T00:00:00Z").toUTCString(),
    })
    expect(future.status).toBe(412)
    for (const name of ["if-match", "if-none-match", "if-unmodified-since", "if-modified-since"])
      expect(await exists(name)).toBe(false)
  })

  test("a satisfied precondition copies", async () => {
    const { etag, copy, exists } = await setup()
    expect(
      (await copy("m", { "x-amz-copy-source-if-match": etag.replace(/"/g, "") })).status,
    ).toBe(200)
    expect(
      (await copy("n", { "x-amz-copy-source-if-none-match": '"00000000000000000000000000000000"' }))
        .status,
    ).toBe(200)
    expect(
      (
        await copy("u", {
          "x-amz-copy-source-if-unmodified-since": new Date("2099-01-01T00:00:00Z").toUTCString(),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await copy("s", {
          "x-amz-copy-source-if-modified-since": new Date(0).toUTCString(),
        })
      ).status,
    ).toBe(200)
    for (const name of ["m", "n", "u", "s"]) expect(await exists(name)).toBe(true)
  })

  test("a true if-match overrides a false if-unmodified-since, as documented", async () => {
    const { etag, copy, exists } = await setup()
    const response = await copy("both", {
      "x-amz-copy-source-if-match": etag,
      "x-amz-copy-source-if-unmodified-since": new Date(0).toUTCString(),
    })
    expect(response.status).toBe(200)
    expect(await exists("both")).toBe(true)
    const combined = await copy("neither", {
      "x-amz-copy-source-if-none-match": etag,
      "x-amz-copy-source-if-modified-since": new Date(0).toUTCString(),
    })
    expect(combined.status).toBe(412)
  })

  test("the SDK surfaces the guard as a 412", async () => {
    const server = await createServer({ buckets: ["videos"] })
    const s3 = clientFor(server.url)
    try {
      await s3.send(new PutObjectCommand({ Bucket: "videos", Key: "raw/a.webm", Body: "v1" }))
      const { ETag } = await s3.send(new HeadObjectCommand({ Bucket: "videos", Key: "raw/a.webm" }))
      const attempt = (extra: Record<string, unknown>) =>
        s3.send(
          new CopyObjectCommand({
            Bucket: "videos",
            Key: "final/a.webm",
            CopySource: "videos/raw/a.webm",
            ...extra,
          }),
        )
      await expect(attempt({ CopySourceIfMatch: '"0000"' })).rejects.toMatchObject({
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      })
      await attempt({ CopySourceIfMatch: ETag })
      expect(
        (await s3.send(new HeadObjectCommand({ Bucket: "videos", Key: "final/a.webm" })))
          .ContentLength,
      ).toBe(2)
    } finally {
      s3.destroy()
      await server.close()
    }
  })
})

describe("aws-chunked streaming PutObject (#512)", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming-trailers.html
  test("a default SDK client's stream upload stores only the payload", async () => {
    const server = await createServer({ buckets: ["results"] })
    const s3 = clientFor(server.url)
    try {
      const data = Buffer.alloc(1000, 0x41)
      await s3.send(
        new PutObjectCommand({
          Bucket: "results",
          Key: "stream.bin",
          Body: Readable.from([data]),
          ContentLength: data.length,
        }),
      )
      const head = await s3.send(new HeadObjectCommand({ Bucket: "results", Key: "stream.bin" }))
      expect(head.ContentLength).toBe(1000)
      const got = await s3.send(new GetObjectCommand({ Bucket: "results", Key: "stream.bin" }))
      expect(Buffer.from(await (got.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray())).toEqual(data)
    } finally {
      s3.destroy()
      await server.close()
    }
  })

  test("a multipart part sent with trailer framing is decoded too", async () => {
    const server = await createServer({ buckets: ["results"] })
    const s3 = clientFor(server.url)
    try {
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: "results", Key: "mp.bin" }),
      )
      const data = Buffer.alloc(300, 0x42)
      await s3.send(
        new UploadPartCommand({
          Bucket: "results",
          Key: "mp.bin",
          UploadId,
          PartNumber: 1,
          Body: Readable.from([data]),
          ContentLength: data.length,
        }),
      )
      const parts = await fetch(`${server.url}/results/mp.bin?uploadId=${UploadId}`)
      expect(await parts.text()).toContain("<Size>300</Size>")
    } finally {
      s3.destroy()
      await server.close()
    }
  })

  const chunked = (payload: string, tail: string, signed = false) => {
    const chunk = (data: string) =>
      `${data.length.toString(16)}${signed ? `;chunk-signature=${"0".repeat(64)}` : ""}\r\n${data}\r\n`
    return `${chunk(payload.slice(0, 4))}${chunk(payload.slice(4))}${signed ? `0;chunk-signature=${"0".repeat(64)}\r\n` : "0\r\n"}${tail}\r\n`
  }
  const raw = (runtime: ReturnType<typeof createRuntime>, body: string, headers: Record<string, string>) =>
    put(runtime, "/docs/chunked.bin", {
      body,
      headers: {
        "content-encoding": "aws-chunked",
        "x-amz-decoded-content-length": "10",
        ...headers,
      },
    })

  test("signed and unsigned framings decode; the trailer checksum is verified", async () => {
    const runtime = seeded()
    const payload = "0123456789"
    // CRC32 of "0123456789" is 0xA684C7C6.
    const crc = Buffer.from([0xa6, 0x84, 0xc7, 0xc6]).toString("base64")
    const signedBody = chunked(payload, `x-amz-checksum-crc32:${crc}\r\nx-amz-trailer-signature:${"0".repeat(64)}\r\n`, true)
    const ok = await raw(runtime, signedBody, {
      "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER",
      "x-amz-trailer": "x-amz-checksum-crc32",
    })
    expect(ok.status).toBe(200)
    const stored = await runtime.fetch(new Request("http://mock/docs/chunked.bin"))
    expect(await stored.text()).toBe(payload)
    expect(stored.headers.get("x-amz-checksum-crc32")).toBe(crc)
    const plain = await raw(runtime, chunked(payload, ""), {
      "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
    })
    expect(plain.status).toBe(200)
    expect(
      await (await runtime.fetch(new Request("http://mock/docs/chunked.bin"))).text(),
    ).toBe(payload)
  })

  test("a wrong trailer checksum or decoded length is rejected without storing", async () => {
    const runtime = seeded()
    const bad = await raw(
      runtime,
      chunked("0123456789", "x-amz-checksum-crc32:AAAAAA==\r\n"),
      {
        "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
        "x-amz-trailer": "x-amz-checksum-crc32",
      },
    )
    expect(bad.status).toBe(400)
    expect(await xmlCode(bad)).toBe("BadDigest")
    const short = await raw(runtime, chunked("012345678", ""), {
      "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
    })
    expect(short.status).toBe(400)
    expect(await xmlCode(short)).toBe("IncompleteBody")
    const garbled = await raw(runtime, "zz\r\nnope", {
      "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
    })
    expect(garbled.status).toBe(400)
    expect((await runtime.fetch(new Request("http://mock/docs/chunked.bin"))).status).toBe(404)
  })

  test("a header checksum on a plain body is verified too", async () => {
    const runtime = seeded()
    const bad = await put(runtime, "/docs/plain.bin", {
      body: "0123456789",
      headers: { "x-amz-checksum-crc32": "AAAAAA==" },
    })
    expect(bad.status).toBe(400)
    expect(await xmlCode(bad)).toBe("BadDigest")
    const good = await put(runtime, "/docs/plain.bin", {
      body: "0123456789",
      headers: { "x-amz-checksum-crc32": Buffer.from([0xa6, 0x84, 0xc7, 0xc6]).toString("base64") },
    })
    expect(good.status).toBe(200)
  })
})

describe("bodies above 16 MiB (#513)", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html (a single PUT up to 5 GB)
  test("presigned PUT and UploadPart accept 17 MiB by default", async () => {
    const server = await createServer({ buckets: ["videos"], credentials })
    const s3 = clientFor(server.url, { requestChecksumCalculation: "WHEN_REQUIRED" })
    try {
      const body = Buffer.alloc(17 * 1024 * 1024, 1)
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: "videos", Key: "raw/17.webm", ContentType: "video/webm" }),
        { expiresIn: 60 },
      )
      expect((await fetch(url, { method: "PUT", headers: { "content-type": "video/webm" }, body })).status).toBe(200)
      expect(
        (await s3.send(new HeadObjectCommand({ Bucket: "videos", Key: "raw/17.webm" }))).ContentLength,
      ).toBe(body.length)
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: "videos", Key: "raw/mp.webm" }),
      )
      const part = await s3.send(
        new UploadPartCommand({ Bucket: "videos", Key: "raw/mp.webm", UploadId, PartNumber: 1, Body: body }),
      )
      expect(part.ETag).toBeString()
    } finally {
      s3.destroy()
      await server.close()
    }
  }, 60_000)

  test("maxBodyBytes lowers the limit, and S3 itself refuses more than 5 GiB", async () => {
    const server = await createServer({ buckets: ["videos"], maxBodyBytes: 1024 })
    try {
      const res = await fetch(`${server.url}/videos/big`, { method: "PUT", body: Buffer.alloc(2048) })
      expect(res.status).toBe(413)
    } finally {
      await server.close()
    }
    const runtime = createRuntime({ buckets: ["videos"] })
    const tooBig = await runtime.fetch(
      new Request("http://mock/videos/huge", {
        method: "PUT",
        body: "x",
        headers: { "content-length": String(5 * 1024 ** 3 + 1) },
      }),
    )
    expect(tooBig.status).toBe(400)
    expect(await xmlCode(tooBig)).toBe("EntityTooLarge")
  })
})

describe("virtual-hosted-style addressing (#514)", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html
  const vhost = (path: string, init: RequestInit = {}, host = "docs.localhost:9000") =>
    new Request(`http://${host}${path}`, init)

  test("PUT, GET and ListObjectsV2 address the bucket named in the Host", async () => {
    const runtime = seeded()
    const stored = await runtime.fetch(
      vhost("/signatures/p1.png", { method: "PUT", body: "png" }),
    )
    expect(stored.status).toBe(200)
    expect(stored.headers.get("etag")).toBeString()
    const got = await runtime.fetch(vhost("/signatures/p1.png"))
    expect(await got.text()).toBe("png")
    const listed = await runtime.fetch(vhost("/?list-type=2&prefix=signatures/"))
    expect(await listed.text()).toContain("<Key>signatures/p1.png</Key>")
    // Path-style on the same server is unchanged, and the object is the same one.
    const pathStyle = await runtime.fetch(
      new Request("http://localhost:9000/docs/signatures/p1.png"),
    )
    expect(await pathStyle.text()).toBe("png")
    const ip = await runtime.fetch(new Request("http://127.0.0.1:9000/docs/signatures/p1.png"))
    expect(await ip.text()).toBe("png")
  })

  test("an unknown bucket is NoSuchBucket and a flat PutObject never creates one", async () => {
    const runtime = seeded()
    const missing = await runtime.fetch(vhost("/key", {}, "nosuch.localhost:9000"))
    expect(missing.status).toBe(404)
    const body = await missing.text()
    expect(body).toContain("<Code>NoSuchBucket</Code>")
    expect(body).toContain("<BucketName>nosuch</BucketName>")
    await runtime.fetch(vhost("/flat.png", { method: "PUT", body: "x" }))
    await runtime.fetch(vhost("/flat.png", { method: "PUT", body: "x" }, "nosuch.localhost:9000"))
    const buckets = await (await runtime.fetch(new Request("http://localhost:9000/"))).text()
    expect(buckets).toContain("<Name>docs</Name>")
    expect(buckets).not.toContain("flat.png")
    expect(buckets).not.toContain("nosuch")
  })

  test("CreateBucket and DeleteBucket work on the bucket host", async () => {
    const runtime = seeded()
    expect((await runtime.fetch(vhost("/", { method: "PUT" }, "fresh.localhost:9000"))).status).toBe(200)
    expect((await runtime.fetch(vhost("/", { method: "HEAD" }, "fresh.localhost:9000"))).status).toBe(200)
    expect((await runtime.fetch(vhost("/", { method: "DELETE" }, "fresh.localhost:9000"))).status).toBe(204)
  })

  test("other base hosts are configurable, and dotted bucket names work", async () => {
    const runtime = seeded({ buckets: ["my.bucket"], virtualHosts: ["s3.test"] })
    const stored = await runtime.fetch(
      vhost("/k", { method: "PUT", body: "v" }, "my.bucket.s3.test"),
    )
    expect(stored.status).toBe(200)
    expect(await (await runtime.fetch(new Request("http://x/my.bucket/k"))).text()).toBe("v")
    // `localhost` is no longer a base host here, so it is plain path-style.
    expect(
      (await runtime.fetch(vhost("/", {}, "docs.localhost:9000"))).status,
    ).toBe(200)
  })

  test("a presigned GET minted for the bucket host verifies against that Host", async () => {
    const runtime = seeded()
    await runtime.fetch(vhost("/key.txt", { method: "PUT", body: "hello" }))
    const s3 = new S3Client({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      credentials: signing,
    })
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "docs", Key: "key.txt" }), {
      expiresIn: 60,
    })
    expect(new URL(url).host).toBe("docs.localhost:9000")
    const ok = await runtime.fetch(new Request(url))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("hello")
    const forged = await runtime.fetch(new Request(url.replace("key.txt", "other.txt")))
    expect(await xmlCode(forged)).toBe("SignatureDoesNotMatch")
    s3.destroy()
  })

  test("an SDK client with no forcePathStyle works through the server", async () => {
    const server = await createServer({ buckets: ["docs"] })
    // The SDK addresses docs.localhost:<port>; deliver it to the loopback server without DNS.
    const port = server.port
    const requestHandler = {
      metadata: { handlerProtocol: "http/1.1" },
      destroy() {},
      handle: (request: {
        method: string
        path: string
        query?: Record<string, string>
        headers: Record<string, string>
        body?: Uint8Array | string
      }) =>
        new Promise((resolve, reject) => {
          const query = new URLSearchParams(request.query ?? {}).toString()
          const outgoing = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: request.method,
              path: query ? `${request.path}?${query}` : request.path,
              headers: request.headers,
            },
            (incoming) =>
              resolve({
                response: {
                  statusCode: incoming.statusCode,
                  headers: incoming.headers,
                  body: incoming,
                },
              }),
          )
          outgoing.on("error", reject)
          outgoing.end(request.body as Uint8Array | string | undefined)
        }),
    }
    const s3 = new S3Client({
      endpoint: `http://localhost:${port}`,
      region: "us-east-1",
      credentials: signing,
      requestHandler: requestHandler as never,
    })
    try {
      await s3.send(new PutObjectCommand({ Bucket: "docs", Key: "signatures/p1.png", Body: "png" }))
      await s3.send(new PutObjectCommand({ Bucket: "docs", Key: "flat.png", Body: "png" }))
      const got = await s3.send(new GetObjectCommand({ Bucket: "docs", Key: "flat.png" }))
      expect(await got.Body?.transformToString()).toBe("png")
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: "docs", Prefix: "sig" }))
      expect(listed.Contents?.map((entry) => entry.Key)).toEqual(["signatures/p1.png"])
      const all = await fetch(`${server.url}/`)
      expect(await all.text()).not.toContain("flat.png")
    } finally {
      s3.destroy()
      await server.close()
    }
  })

  test("operation-keyed faults still match on a bucket host", async () => {
    const runtime = seeded()
    await runtime.fetch(vhost("/k", { method: "PUT", body: "abcd" }))
    const log: (string | undefined)[] = []
    const logged = createRuntime({
      buckets: ["docs"],
      onLog: (entry) => log.push(entry.operationId),
    })
    await logged.fetch(vhost("/k", { method: "PUT", body: "abcd" }))
    await logged.fetch(vhost("/k"))
    expect(log).toEqual(["PutObject", "GetObject"])
  })
})

describe("bucket CORS enforcement (#515)", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html
  const origin = "http://localhost:5173"
  const rules = `<CORSConfiguration><CORSRule><AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`
  const configured = async (config = rules) => {
    const runtime = seeded()
    await put(runtime, "/docs?cors", { body: config })
    return runtime
  }
  const preflight = (path: string, headers: Record<string, string>) =>
    new Request(`http://mock${path}`, { method: "OPTIONS", headers })

  test("preflight on a presigned URL answers 200 with the allow headers", async () => {
    const server = await createServer({ buckets: ["videos"], credentials })
    const s3 = clientFor(server.url)
    try {
      await s3.send(
        new PutBucketCorsCommand({
          Bucket: "videos",
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [origin],
                AllowedMethods: ["PUT", "GET", "HEAD"],
                AllowedHeaders: ["*"],
                ExposeHeaders: ["ETag"],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      )
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: "videos", Key: "raw/clip.webm", ContentType: "video/webm" }),
        { expiresIn: 60 },
      )
      const pre = await fetch(url, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      })
      expect(pre.status).toBe(200)
      expect(pre.headers.get("access-control-allow-origin")).toBe(origin)
      expect(pre.headers.get("access-control-allow-methods")).toContain("PUT")
      expect(pre.headers.get("access-control-allow-headers")).toBe("content-type")
      expect(pre.headers.get("access-control-max-age")).toBe("3600")
      expect(pre.headers.get("vary")).toBe(
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
      )
      const upload = await fetch(url, {
        method: "PUT",
        headers: { origin, "content-type": "video/webm" },
        body: "x",
      })
      expect(upload.status).toBe(200)
      expect(upload.headers.get("access-control-allow-origin")).toBe(origin)
      expect(upload.headers.get("access-control-expose-headers")).toBe("ETag")
      expect(upload.headers.get("vary")).toContain("Origin")
    } finally {
      s3.destroy()
      await server.close()
    }
  })

  test("actual requests get CORS headers on matching rules only, errors included", async () => {
    const runtime = await configured()
    const missing = await runtime.fetch(
      new Request("http://mock/docs/absent", { headers: { origin } }),
    )
    expect(missing.status).toBe(404)
    expect(missing.headers.get("access-control-allow-origin")).toBe(origin)
    const other = await runtime.fetch(
      new Request("http://mock/docs/absent", { headers: { origin: "http://evil.test" } }),
    )
    expect(other.headers.get("access-control-allow-origin")).toBeNull()
    const none = await runtime.fetch(new Request("http://mock/docs/absent"))
    expect(none.headers.get("access-control-allow-origin")).toBeNull()
    // DELETE is not an allowed method in the rule.
    const deleted = await runtime.fetch(
      new Request("http://mock/docs/absent", { method: "DELETE", headers: { origin } }),
    )
    expect(deleted.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("a rule with wildcard origin answers *, and the first matching rule wins", async () => {
    const runtime = await configured(
      `<CORSConfiguration><CORSRule><AllowedOrigin>https://*.example.test</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>x-amz-*</AllowedHeader></CORSRule><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod></CORSRule></CORSConfiguration>`,
    )
    const wildcard = await runtime.fetch(
      preflight("/docs/k", {
        origin: "http://anywhere.test",
        "access-control-request-method": "PUT",
      }),
    )
    expect(wildcard.status).toBe(200)
    expect(wildcard.headers.get("access-control-allow-origin")).toBe("*")
    const sub = await runtime.fetch(
      preflight("/docs/k", {
        origin: "https://app.example.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Amz-Date, x-amz-meta-a",
      }),
    )
    expect(sub.status).toBe(200)
    expect(sub.headers.get("access-control-allow-origin")).toBe("https://app.example.test")
    expect(sub.headers.get("access-control-allow-headers")).toBe("x-amz-date, x-amz-meta-a")
    // The first rule matches the origin but not the header, so the second (any origin) answers.
    const fallthrough = await runtime.fetch(
      preflight("/docs/k", {
        origin: "https://app.example.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      }),
    )
    expect(fallthrough.headers.get("access-control-allow-origin")).toBe("*")
  })

  test("a disallowed preflight is 403 AccessForbidden with no CORS headers", async () => {
    const runtime = await configured()
    for (const headers of [
      { origin: "http://evil.test", "access-control-request-method": "PUT" },
      { origin, "access-control-request-method": "DELETE" },
    ]) {
      const response = await runtime.fetch(preflight("/docs/k", headers))
      expect(response.status).toBe(403)
      const body = await response.text()
      expect(body).toContain("<Code>AccessForbidden</Code>")
      expect(body).toContain("CORSResponse: This CORS request is not allowed.")
      expect([...response.headers.keys()].some((name) => name.startsWith("access-control"))).toBe(false)
    }
  })

  test("a bucket without CORS, or after DeleteBucketCors, refuses the preflight", async () => {
    const runtime = seeded()
    const headers = { origin, "access-control-request-method": "PUT" }
    const before = await runtime.fetch(preflight("/docs/k?X-Amz-Signature=nope", headers))
    expect(before.status).toBe(403)
    expect(await before.text()).toContain("CORSResponse: CORS is not enabled for this bucket.")
    await put(runtime, "/docs?cors", { body: rules })
    expect((await runtime.fetch(preflight("/docs/k", headers))).status).toBe(200)
    await runtime.fetch(new Request("http://mock/docs?cors", { method: "DELETE" }))
    const after = await runtime.fetch(preflight("/docs/k", headers))
    expect(after.status).toBe(403)
    expect(await after.text()).toContain("CORS is not enabled for this bucket.")
  })

  test("incomplete preflights and missing buckets are rejected like S3", async () => {
    const runtime = await configured()
    const noOrigin = await runtime.fetch(preflight("/docs/k", {}))
    expect(noOrigin.status).toBe(400)
    expect(await xmlCode(noOrigin)).toBe("BadRequest")
    const noMethod = await runtime.fetch(preflight("/docs/k", { origin }))
    expect(noMethod.status).toBe(400)
    const noBucket = await runtime.fetch(
      preflight("/nosuch/k", { origin, "access-control-request-method": "GET" }),
    )
    expect(noBucket.status).toBe(404)
    expect(await xmlCode(noBucket)).toBe("NoSuchBucket")
  })

  test("the bucket-level preflight and bucket-host preflight work too", async () => {
    const runtime = await configured()
    const headers = { origin, "access-control-request-method": "GET" }
    expect((await runtime.fetch(preflight("/docs", headers))).status).toBe(200)
    const virtual = await runtime.fetch(
      new Request("http://docs.localhost:9000/k", { method: "OPTIONS", headers }),
    )
    expect(virtual.status).toBe(200)
  })

  test("PutBucketCors rejects unsupported methods and empty rules", async () => {
    const runtime = seeded()
    const bad = await put(runtime, "/docs?cors", {
      body: "<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PATCH</AllowedMethod></CORSRule></CORSConfiguration>",
    })
    expect(bad.status).toBe(400)
    expect(await xmlCode(bad)).toBe("InvalidRequest")
    const empty = await put(runtime, "/docs?cors", { body: "<CORSConfiguration></CORSConfiguration>" })
    expect(empty.status).toBe(400)
    expect(await xmlCode(empty)).toBe("MalformedXML")
    const noOrigin = await put(runtime, "/docs?cors", {
      body: "<CORSConfiguration><CORSRule><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>",
    })
    expect(noOrigin.status).toBe(400)
  })
})
