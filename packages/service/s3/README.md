# @crvouga/mockingbird-service-s3

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Amazon S3 emulator for AWS SDK v3. It preserves binary objects and the metadata applications read, supports path-style endpoints, multipart uploads, copies, ranges, pagination, presigned URLs, XML errors, namespace isolation, faults, and object notifications without contacting AWS.

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

Set an application's S3 endpoint environment variable to the server URL and its region to `us-east-1`. Supported REST operations are CreateBucket, HeadBucket, PutObject, GetObject, HeadObject, DeleteObject, DeleteObjects, CopyObject, ListObjectsV2, and multipart create/upload/complete/abort. SDK `GetObject` bodies retain its streaming helpers.

### Request semantics

Each behavior follows the linked Amazon S3 reference.

- **Response header overrides** ([GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)): `response-cache-control`, `response-content-disposition`, `response-content-encoding`, `response-content-language`, `response-content-type` and `response-expires` replace the stored header on a 200 or 206 GetObject and on HeadObject. Like S3, they are refused with `400 InvalidRequest` on anonymous requests.
- **Copy-source preconditions** ([CopyObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html)): `x-amz-copy-source-if-match`, `-if-none-match`, `-if-modified-since` and `-if-unmodified-since` are evaluated against the source object. An unmet precondition answers `412 PreconditionFailed` and copies nothing; a true `if-match` overrides a false `if-unmodified-since`, and a matching `if-none-match` is `412` whatever `if-modified-since` says, as documented. When `if-none-match` is present, `if-modified-since` is not consulted (best guess, not oracle-verified: the reference does not state it).
- **Streaming uploads** ([SigV4 streaming](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html), [with trailers](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming-trailers.html)): `Content-Encoding: aws-chunked` bodies (signed and `STREAMING-UNSIGNED-PAYLOAD-TRAILER`) are decoded before storing, on PutObject and UploadPart. The stored length is `x-amz-decoded-content-length`; a trailer or header `x-amz-checksum-*` that does not match, or a wrong decoded length, is rejected with `400` (`BadDigest` / `IncompleteBody`) and stores nothing. Chunk signatures are not verified.
- **Body size** ([upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)): `createServer` accepts bodies up to 5 GiB, the S3 maximum for one PUT or part, and answers larger ones with S3's `EntityTooLarge`. `createServer({ maxBodyBytes })` lowers the limit. `mockingbird-s3 serve` and fleet entries use the same 5 GiB limit (the target sets `maxBodyBytes`; other services keep the adapter's 16 MiB default).
- **Virtual-hosted-style addressing** ([VirtualHosting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html)): `Host: <bucket>.<base host>` names the bucket and the path is the key, so an SDK client without `forcePathStyle` works against `AWS_ENDPOINT_URL_S3=http://localhost:<port>`. The base hosts default to `localhost` (so `docs.localhost`); set `virtualHosts` (`--virtual-host a,b`, empty for path-style only) to change them. Path-style requests and IP or other hosts are unchanged, an unknown bucket is `NoSuchBucket`, no request ever creates a bucket as a side effect, presigned URLs are verified against the virtual host, and the admin prefix keeps its path on any host.
- **Bucket CORS** ([CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html), [PutBucketCors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html), [OPTIONS object](https://docs.aws.amazon.com/AmazonS3/latest/API/RESTOPTIONSobject.html)): the stored `CORSConfiguration` is enforced. An unauthenticated `OPTIONS` preflight (any `X-Amz-*` query is ignored) is answered by the first rule matching origin, method and requested headers with `Access-Control-Allow-Origin/-Methods/-Headers/-Max-Age/-Expose-Headers` and `Vary`; otherwise it is `403 AccessForbidden` ("CORSResponse: This CORS request is not allowed.", or "CORS is not enabled for this bucket." with no rules or after `DeleteBucketCors`) with no `Access-Control-*` headers. Actual requests with an allowed `Origin` and method get `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers` and `Vary: Origin`, errors included. `PutBucketCors` rejects empty rule sets, unsupported methods and multiple wildcards. Best guess, not oracle-verified: the exact set and ordering of preflight headers beyond what the docs list (the `AccessForbidden` error code matches what S3 and s3rver return for a disabled bucket); no live AWS bucket was exercised.

### Admin and deterministic controls

- `GET/POST /__admin/objects` inspects metadata or seeds an object; `GET /__admin/objects/:bucket/:key` downloads its bytes.
- `GET /__admin/uploads` inspects active uploads and part metadata.
- Preset faults are `slow_down`, `access_denied`, `expired_token`, and one-shot `truncate_stream`. Generic faults can fail or reset the next part request.
- Advance the shared emulator clock through `/__admin/clock` to expire a presigned URL.
- Object writes, copies, multipart completion, and deletes publish S3-shaped notifications. Configure HTTP sinks through runtime `webhooks` options or the shared webhook admin routes; delivery attempts and retries appear under `/__admin/webhooks`.

The shared runtime also provides health, reset, journal, metrics, timeline, and fault routes. Select isolated state with `x-mockingbird-namespace`, `/__admin/ns/<name>`, or a SigV4 access-key mapping.

### Deliberately not modelled

Operations outside the surface listed above, object versioning, ACL/IAM policy evaluation, storage classes, checksums beyond ETags, production quotas, AWS dashboards and billing, and real SQS delivery are not modelled. SQS consumers can use the same captured notification payload through a configured HTTP sink.

## API

- `S3API`, `S3APIOptions`: Fetch handler and configuration.
- `S3Notification`, `S3Object`, `S3SeedObject`: notification, state, and fixture types.
- `createRuntime`, `S3Runtime`, `S3RuntimeOptions`: full Mockingbird runtime and webhook hub.
- `S3_NAMESPACE`, `S3_PRESETS`, `accessKeyCredential`: constants and fault controls.
- `S3_MAX_UPLOAD_BYTES`: the default request body limit (5 GiB) for `createServer`.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `S3ServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon S3 API Reference](https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html) and [AWS Signature Version 4 query authentication](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html).
