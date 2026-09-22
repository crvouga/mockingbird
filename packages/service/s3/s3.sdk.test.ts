import { describe, expect, test } from "bun:test"
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createServer } from "./src/server.js"

describe("AWS SDK v3 against S3 mock", () => {
  test("binary objects, metadata, ranges, copies, listing and bulk delete", async () => {
    const server = await createServer()
    const client = new S3Client({
      endpoint: server.url,
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: "results" }))
      const bytes = Uint8Array.from([0, 1, 2, 255, 10, 0, 42])
      const put = await client.send(
        new PutObjectCommand({
          Bucket: "results",
          Key: "nested/result.bin",
          Body: bytes,
          ContentType: "application/octet-stream",
          CacheControl: "max-age=60",
          Metadata: { order: "fixture-1" },
        }),
      )
      expect(put.ETag).toBeString()
      const got = await client.send(
        new GetObjectCommand({ Bucket: "results", Key: "nested/result.bin" }),
      )
      expect(await got.Body?.transformToByteArray()).toEqual(bytes)
      expect(got.Metadata).toEqual({ order: "fixture-1" })
      expect(
        await (
          await client.send(
            new GetObjectCommand({
              Bucket: "results",
              Key: "nested/result.bin",
              Range: "bytes=2-4",
            }),
          )
        ).Body?.transformToByteArray(),
      ).toEqual(Uint8Array.from([2, 255, 10]))
      await client.send(
        new CopyObjectCommand({
          Bucket: "results",
          Key: "copied.bin",
          CopySource: "results/nested%2Fresult.bin",
        }),
      )
      expect(
        (await client.send(new HeadObjectCommand({ Bucket: "results", Key: "copied.bin" })))
          .ContentLength,
      ).toBe(bytes.length)
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: "results", Delimiter: "/", MaxKeys: 10 }),
      )
      expect(listed.Contents?.map((entry) => entry.Key)).toEqual(["copied.bin"])
      expect(listed.CommonPrefixes?.map((entry) => entry.Prefix)).toEqual(["nested/"])
      await client.send(
        new DeleteObjectsCommand({
          Bucket: "results",
          Delete: { Objects: [{ Key: "copied.bin" }, { Key: "nested/result.bin" }] },
        }),
      )
      expect((await client.send(new ListObjectsV2Command({ Bucket: "results" }))).KeyCount).toBe(0)
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("lib-storage multipart and presigned PUT/GET work unchanged", async () => {
    const server = await createServer()
    const client = new S3Client({
      endpoint: server.url,
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: "uploads" }))
      const large = new Uint8Array(6 * 1024 * 1024)
      large.fill(7)
      await new Upload({
        client,
        params: { Bucket: "uploads", Key: "large.bin", Body: large },
        partSize: 5 * 1024 * 1024,
      }).done()
      expect(
        (await client.send(new HeadObjectCommand({ Bucket: "uploads", Key: "large.bin" })))
          .ContentLength,
      ).toBe(large.length)
      const putUrl = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: "uploads", Key: "signed.txt" }),
        { expiresIn: 60 },
      )
      expect((await fetch(putUrl, { method: "PUT", body: "signed" })).status).toBe(200)
      const getUrl = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: "uploads", Key: "signed.txt" }),
        { expiresIn: 60 },
      )
      expect(await (await fetch(getUrl)).text()).toBe("signed")
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
