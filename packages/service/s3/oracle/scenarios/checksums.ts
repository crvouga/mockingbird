import { createHash } from "node:crypto"
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { keyPath, type Scenario } from "../harness.js"

const bytes = (text: string) => new TextEncoder().encode(text)
const BODY = "hello checksum"

const crcTable = (polynomial: number) =>
  Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ polynomial : value >>> 1
    return value >>> 0
  })
const crc = (data: Uint8Array, table: number[]) => {
  let value = 0xffffffff
  for (const byte of data) value = (table[(value ^ byte) & 0xff] as number) ^ (value >>> 8)
  const out = (value ^ 0xffffffff) >>> 0
  return Buffer.from([out >>> 24, (out >>> 16) & 0xff, (out >>> 8) & 0xff, out & 0xff]).toString(
    "base64",
  )
}
const crc64nvme = (data: Uint8Array) => {
  const poly = 0x9a6c9329ac4bc9b5n
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = BigInt(index)
    for (let bit = 0; bit < 8; bit++) value = value & 1n ? (value >> 1n) ^ poly : value >> 1n
    return value
  })
  let value = 0xffffffffffffffffn
  for (const byte of data)
    value = (table[Number((value ^ BigInt(byte)) & 0xffn)] as bigint) ^ (value >> 8n)
  value ^= 0xffffffffffffffffn
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out.toString("base64")
}
const IEEE = crcTable(0xedb88320)
const CASTAGNOLI = crcTable(0x82f63b78)
const digests = (data: Uint8Array) => ({
  crc32: crc(data, IEEE),
  crc32c: crc(data, CASTAGNOLI),
  crc64nvme: crc64nvme(data),
  sha1: createHash("sha1").update(data).digest("base64"),
  sha256: createHash("sha256").update(data).digest("base64"),
})
const GOOD = digests(bytes(BODY))
const WRONG = digests(bytes("something else"))
const ALGORITHMS = ["crc32", "crc32c", "crc64nvme", "sha1", "sha256"] as const

export const scenarios: Scenario[] = [
  {
    name: "each-algorithm",
    async run(s) {
      const b = await s.bucket("cks")
      for (const algorithm of ALGORITHMS) {
        const key = `obj-${algorithm}`
        await s.req(`put ${algorithm}`, {
          method: "PUT",
          path: keyPath(b, key),
          body: bytes(BODY),
          headers: { [`x-amz-checksum-${algorithm}`]: GOOD[algorithm] },
        })
        await s.req(`get ${algorithm} default`, { method: "GET", path: keyPath(b, key) })
        await s.req(`get ${algorithm} mode`, {
          method: "GET",
          path: keyPath(b, key),
          headers: { "x-amz-checksum-mode": "ENABLED" },
        })
        await s.req(`head ${algorithm} mode`, {
          method: "HEAD",
          path: keyPath(b, key),
          headers: { "x-amz-checksum-mode": "ENABLED" },
        })
        await s.req(`ranged ${algorithm} mode`, {
          method: "GET",
          path: keyPath(b, key),
          headers: { "x-amz-checksum-mode": "ENABLED", range: "bytes=0-1" },
        })
        await s.req(`part 1 ${algorithm} mode`, {
          method: "HEAD",
          path: keyPath(b, key),
          query: { partNumber: "1" },
          headers: { "x-amz-checksum-mode": "ENABLED" },
        })
      }
    },
  },
  {
    name: "mismatch",
    async run(s) {
      const b = await s.bucket("cks")
      for (const algorithm of ALGORITHMS)
        await s.req(`wrong ${algorithm}`, {
          method: "PUT",
          path: keyPath(b, "k"),
          body: bytes(BODY),
          headers: { [`x-amz-checksum-${algorithm}`]: WRONG[algorithm] },
        })
      await s.req("nothing stored", { method: "HEAD", path: keyPath(b, "k") })
    },
  },
  {
    name: "invalid-values",
    async run(s) {
      const b = await s.bucket("cks")
      await s.req("not base64", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32": "!!!!" },
      })
      await s.req("wrong length", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32": GOOD.sha1 },
      })
      await s.req("two checksums", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32": GOOD.crc32, "x-amz-checksum-sha256": GOOD.sha256 },
      })
      await s.req("empty value", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32": "" },
      })
      await s.req("composite suffix", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32": `${GOOD.crc32}-2` },
      })
      await s.req("head composite", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("bad suffix", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32": `${GOOD.crc32}-x` },
      })
    },
  },
  {
    name: "algorithm-header",
    async run(s) {
      const b = await s.bucket("cks")
      await s.req("algorithm with value", {
        method: "PUT",
        path: keyPath(b, "a"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-algorithm": "SHA256", "x-amz-checksum-sha256": GOOD.sha256 },
      })
      await s.req("head a", {
        method: "HEAD",
        path: keyPath(b, "a"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("algorithm lowercase", {
        method: "PUT",
        path: keyPath(b, "b"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-algorithm": "crc32c", "x-amz-checksum-crc32c": GOOD.crc32c },
      })
      await s.req("algorithm without value", {
        method: "PUT",
        path: keyPath(b, "c"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-algorithm": "CRC32" },
      })
      await s.req("head c", {
        method: "HEAD",
        path: keyPath(b, "c"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("algorithm with other value", {
        method: "PUT",
        path: keyPath(b, "d"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-algorithm": "CRC32", "x-amz-checksum-sha1": GOOD.sha1 },
      })
      await s.req("head d", {
        method: "HEAD",
        path: keyPath(b, "d"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("unknown algorithm", {
        method: "PUT",
        path: keyPath(b, "e"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-algorithm": "MD5" },
      })
      await s.req("algorithm mismatch", {
        method: "PUT",
        path: keyPath(b, "f"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-algorithm": "CRC32", "x-amz-checksum-crc32": WRONG.crc32 },
      })
      await s.req("sdk algorithm header only", {
        method: "PUT",
        path: keyPath(b, "g"),
        body: bytes(BODY),
        headers: { "x-amz-sdk-checksum-algorithm": "CRC32", "x-amz-checksum-crc32": GOOD.crc32 },
      })
    },
  },
  {
    name: "checksum-type-header",
    async run(s) {
      const b = await s.bucket("cks")
      await s.req("full object crc32", {
        method: "PUT",
        path: keyPath(b, "a"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-type": "FULL_OBJECT", "x-amz-checksum-crc32": GOOD.crc32 },
      })
      await s.req("full object sha256", {
        method: "PUT",
        path: keyPath(b, "b"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-type": "FULL_OBJECT", "x-amz-checksum-sha256": GOOD.sha256 },
      })
      await s.req("composite crc32", {
        method: "PUT",
        path: keyPath(b, "c"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-type": "COMPOSITE", "x-amz-checksum-crc32": GOOD.crc32 },
      })
      await s.req("head c", {
        method: "HEAD",
        path: keyPath(b, "c"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("bogus type", {
        method: "PUT",
        path: keyPath(b, "d"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-type": "BOGUS", "x-amz-checksum-crc32": GOOD.crc32 },
      })
    },
  },
  {
    name: "checksum-mode-values",
    async run(s) {
      const b = await s.bucket("cks")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-sha1": GOOD.sha1 },
      })
      await s.req("mode lowercase", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "enabled" },
      })
      await s.req("mode disabled", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "DISABLED" },
      })
      await s.req("mode with 304", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "ENABLED", "if-none-match": "*" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "plain"), body: bytes(BODY) })
      await s.req("mode on object without checksum", {
        method: "GET",
        path: keyPath(b, "plain"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "with-content-md5",
    async run(s) {
      const b = await s.bucket("cks")
      const md5 = createHash("md5").update(BODY).digest("base64")
      const wrongMd5 = createHash("md5").update("nope").digest("base64")
      await s.req("both good", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "content-md5": md5, "x-amz-checksum-crc32": GOOD.crc32 },
      })
      await s.req("md5 wrong checksum good", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "content-md5": wrongMd5, "x-amz-checksum-crc32": GOOD.crc32 },
      })
      await s.req("md5 good checksum wrong", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "content-md5": md5, "x-amz-checksum-crc32": WRONG.crc32 },
      })
      await s.req("both wrong", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "content-md5": wrongMd5, "x-amz-checksum-crc32": WRONG.crc32 },
      })
      await s.req("invalid md5 and invalid checksum", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "content-md5": "bad", "x-amz-checksum-crc32": "!!" },
      })
    },
  },
  {
    name: "unsigned-payload",
    async run(s) {
      const b = await s.bucket("cks")
      await s.req("unsigned with checksum", {
        method: "PUT",
        path: keyPath(b, "k"),
        auth: "unsigned-payload",
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32c": GOOD.crc32c },
      })
      await s.req("unsigned wrong checksum", {
        method: "PUT",
        path: keyPath(b, "k2"),
        auth: "unsigned-payload",
        body: bytes(BODY),
        headers: { "x-amz-checksum-crc32c": WRONG.crc32c },
      })
      await s.req("head", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "trailer",
    async run(s) {
      const b = await s.bucket("cks")
      await s.req("trailing crc32", {
        method: "PUT",
        path: keyPath(b, "t"),
        auth: "streaming-unsigned-trailer",
        body: bytes(BODY),
        trailer: ["x-amz-checksum-crc32", GOOD.crc32],
        chunkSize: 5,
      })
      await s.req("head", {
        method: "HEAD",
        path: keyPath(b, "t"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("trailing wrong", {
        method: "PUT",
        path: keyPath(b, "t2"),
        auth: "streaming-unsigned-trailer",
        body: bytes(BODY),
        trailer: ["x-amz-checksum-crc32", WRONG.crc32],
      })
      await s.req("trailing sha256", {
        method: "PUT",
        path: keyPath(b, "t3"),
        auth: "streaming-unsigned-trailer",
        body: bytes(BODY),
        trailer: ["x-amz-checksum-sha256", GOOD.sha256],
      })
      await s.req("get t3", {
        method: "GET",
        path: keyPath(b, "t3"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "empty-body",
    async run(s) {
      const b = await s.bucket("cks")
      const empty = digests(new Uint8Array())
      for (const algorithm of ALGORITHMS)
        await s.req(`empty ${algorithm}`, {
          method: "PUT",
          path: keyPath(b, `e-${algorithm}`),
          body: new Uint8Array(),
          headers: { [`x-amz-checksum-${algorithm}`]: empty[algorithm] },
        })
      await s.req("head crc64", {
        method: "HEAD",
        path: keyPath(b, "e-crc64nvme"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "overwrite-drops-checksum",
    async run(s) {
      const b = await s.bucket("cks")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes(BODY),
        headers: { "x-amz-checksum-sha256": GOOD.sha256 },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes(BODY) })
      await s.req("head after plain overwrite", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "sdk-algorithms",
    async run(s) {
      const b = await s.bucket("cks")
      const client = s.sdk()
      for (const algorithm of ["CRC32", "CRC32C", "SHA1", "SHA256", "CRC64NVME"] as const) {
        const key = `sdk-${algorithm}`
        s.record(
          `put ${algorithm}`,
          await client.send(
            new PutObjectCommand({ Bucket: b, Key: key, Body: BODY, ChecksumAlgorithm: algorithm }),
          ),
        )
        s.record(
          `head ${algorithm}`,
          await client.send(
            new HeadObjectCommand({ Bucket: b, Key: key, ChecksumMode: "ENABLED" }),
          ),
        )
        const got = await client.send(
          new GetObjectCommand({ Bucket: b, Key: key, ChecksumMode: "ENABLED" }),
        )
        const { Body, ...rest } = got
        s.record(`get ${algorithm}`, rest)
        s.record(`body ${algorithm}`, await Body?.transformToString())
      }
      s.record(
        "explicit wrong checksum",
        await s.errorName(() =>
          client.send(
            new PutObjectCommand({
              Bucket: b,
              Key: "bad",
              Body: BODY,
              ChecksumSHA256: WRONG.sha256,
            }),
          ),
        ),
      )
    },
  },
]
