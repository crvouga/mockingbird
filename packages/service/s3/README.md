# @crvouga/mockingbird-service-s3

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful S3 emulator that answers exactly as [MinIO](https://github.com/minio/minio) does, so it drops in for MinIO, Amazon S3 and other S3-compatible storage in tests. Every behavior is pinned by a differential oracle: 370 scripted scenarios (about 3,800 HTTP exchanges) were recorded against MinIO `RELEASE.2025-10-15T17-29-55Z`, and `bun test` replays each one against the emulator and requires the same status, headers and XML byte for byte.

## Install

```bash
npm install -D @crvouga/mockingbird-service-s3
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point the SDK endpoint at the emulator and enable path-style addressing. Fixture credentials are validated for presigned requests; the default pair is `fixture` / `fixture`.

```ts
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { createServer } from "@crvouga/mockingbird-service-s3/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const s3 = new S3Client({
  endpoint: server.url,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the S3 SDK calls it already makes.
await s3.send(new CreateBucketCommand({ Bucket: "fixtures" }))
await s3.send(
  new PutObjectCommand({ Bucket: "fixtures", Key: "result.bin", Body: new Uint8Array([0, 255]) }),
)
const object = await s3.send(new GetObjectCommand({ Bucket: "fixtures", Key: "result.bin" }))
console.log(await object.Body?.transformToByteArray()) // Uint8Array(2) [ 0, 255 ]

await server.close()
```

Set an application's S3 endpoint environment variable to the server URL and its region to `us-east-1`.

### Supported operations

Everything MinIO's S3 router serves, with MinIO's precedence, validation order, error codes and messages (generated from MinIO's own error table):

- **Buckets**: CreateBucket (location constraint, object-lock flag), HeadBucket, DeleteBucket (incl. `x-minio-force-delete`), ListBuckets, GetBucketLocation, Get/PutBucketVersioning (incl. MinIO's excluded prefixes), Get/Put/DeleteBucketPolicy and GetBucketPolicyStatus, Get/Put/DeleteBucketTagging, Get/Put/DeleteBucketLifecycle, Get/Put/DeleteBucketEncryption, Get/PutBucketNotification, Get/Put/DeleteBucketReplication, Get/PutObjectLockConfiguration, the ACL, website, accelerate, request-payment and logging stubs, and MinIO's ListenNotification and replication extensions.
- **Objects**: PutObject, GetObject, HeadObject (system and user metadata, conditional reads and writes, every Range form, `partNumber`, `response-*` overrides, checksums CRC32/CRC32C/CRC64NVME/SHA1/SHA256 with `x-amz-checksum-mode`), CopyObject (metadata and tagging directives, copy-source conditionals, versions), DeleteObject and DeleteObjects (delete markers, null versions), Get/Put/DeleteObjectTagging, Get/PutObjectRetention, Get/PutObjectLegalHold, Get/PutObjectAcl, GetObjectAttributes, RestoreObject, SelectObjectContent (CSV and JSON input, basic SQL, event-stream framing), and browser POST uploads (POST policy, V4 and V2 form signatures).
- **Listing**: ListObjects V1, V2 and `metadata=true`, ListObjectVersions, including MinIO's marker and truncation behavior.
- **Multipart**: Create, UploadPart, UploadPartCopy, Complete, Abort, ListParts, ListMultipartUploads, with part checksums and the `<md5>-N` ETag.
- **Authentication**: SigV4 header and presigned, streaming `aws-chunked` (signed chunks and signed or unsigned trailers), SigV2 header and presigned, request-time skew, and anonymous access through bucket policies.

`GetObjectLambda` and `PutObjectExtract` (snowball auto-extract) answer `NotImplemented`.

### Authentication modes

- `authentication: "lenient"` (default): unsigned requests act as the bucket owner and header signatures are not checked, so plain `fetch` works in tests. Presigned URLs are still verified against `credentials` (default `fixture` / `fixture`).
- `authentication: "strict"`: MinIO's authentication exactly. Every request must be signed by a key in `credentials`, and an anonymous request is allowed only where the bucket policy grants it. The oracle runs in this mode.

`region` (default `us-east-1`) is the signing region and the `x-amz-bucket-region` header.

### Where it departs from MinIO

- **Bucket CORS**: MinIO only stubs the bucket CORS API, so the emulator keeps Amazon S3's documented behavior. The stored `CORSConfiguration` is enforced: a preflight is answered by the first matching rule or refused with `403 AccessForbidden`, and matching actual requests get `Access-Control-*` headers. This is not oracle-verified.
- **Virtual-hosted-style addressing**: `Host: <bucket>.<base host>` names the bucket (base hosts default to `localhost`; set `virtualHosts`, or `--virtual-host a,b`, empty for path-style only).
- **Body size**: `createServer` accepts up to 5 GiB per PUT or part (S3's limit; MinIO's is 5 TiB). `createServer({ maxBodyBytes })` lowers it.
- **Listings** always read live data, where MinIO serves later pages from a snapshot taken on the first page.

### The oracle

`oracle/` in the repository holds the harness, the scenarios and the recorded MinIO transcripts. `bun oracle/run.ts` replays them against a live MinIO, `--record` refreshes the transcripts; see [oracle/README.md](https://github.com/crvouga/mockingbird/tree/main/packages/service/s3/oracle).

### Admin and deterministic controls

- `GET/POST /__admin/objects` inspects metadata or seeds an object; `GET /__admin/objects/:bucket/:key` downloads its bytes.
- `GET /__admin/uploads` inspects active uploads and part metadata.
- Preset faults are `slow_down`, `access_denied`, `expired_token`, and one-shot `truncate_stream`. Generic faults can fail or reset the next part request.
- Advance the shared emulator clock through `/__admin/clock` to expire a presigned URL.
- Object writes, copies, multipart completion, and deletes publish S3-shaped notifications. Configure HTTP sinks through runtime `webhooks` options or the shared webhook admin routes; delivery attempts and retries appear under `/__admin/webhooks`.

The shared runtime also provides health, reset, journal, metrics, timeline, and fault routes. Select isolated state with `x-mockingbird-namespace`, `/__admin/ns/<name>`, or a SigV4 access-key mapping.

### Deliberately not modelled

SSE-C and SSE-KMS encryption (MinIO needs TLS and a KMS for them), IAM users and policies other than the root credentials and bucket policies, actually applying lifecycle rules or replicating, and real SQS delivery. SQS consumers can use the captured notification payload through a configured HTTP sink.

## API

- `S3API`, `S3APIOptions`: Fetch handler and configuration.
- `S3Notification`, `S3Object` (`ObjectVersion`), `S3SeedObject`, `BucketRecord`, `MultipartUpload`, `MultipartPart`: notification, state, and fixture types.
- `createRuntime`, `S3Runtime`, `S3RuntimeOptions`: full Mockingbird runtime and webhook hub.
- `S3_NAMESPACE`, `S3_PRESETS`, `accessKeyCredential`: constants and fault controls.
- `S3_MAX_UPLOAD_BYTES`: the default request body limit (5 GiB) for `createServer`.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `S3ServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Oracle: [MinIO](https://github.com/minio/minio) `RELEASE.2025-10-15T17-29-55Z`, with the [Amazon S3 API Reference](https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html) for bucket CORS.
