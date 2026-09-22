# @crvouga/mockingbird-service-s3

Stateful, portable Amazon S3 mock for AWS SDK v3. It preserves binary objects and the metadata applications read, supports path-style endpoints, multipart uploads, copies, ranges, pagination, presigned URLs, XML errors, namespace isolation, faults, and object notifications without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-s3
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point the SDK endpoint at the mock and enable path-style addressing. Fixture credentials are validated for presigned requests; the default pair is `fixture` / `fixture`.

```ts
import { createServer } from "@crvouga/mockingbird-service-s3/server"

const mock = await createServer()
await fetch(`${mock.url}/fixtures`, { method: "PUT" })
await fetch(`${mock.url}/fixtures/result.bin`, {
  method: "PUT",
  body: new Uint8Array([0, 255]),
})
```

Set an application's S3 endpoint environment variable to the server URL and its region to `us-east-1`. Supported REST operations are CreateBucket, HeadBucket, PutObject, GetObject, HeadObject, DeleteObject, DeleteObjects, CopyObject, ListObjectsV2, and multipart create/upload/complete/abort. SDK `GetObject` bodies retain its streaming helpers.

### Admin and deterministic controls

- `GET/POST /__admin/objects` inspects metadata or seeds an object; `GET /__admin/objects/:bucket/:key` downloads its bytes.
- `GET /__admin/uploads` inspects active uploads and part metadata.
- Preset faults are `slow_down`, `access_denied`, `expired_token`, and one-shot `truncate_stream`. Generic faults can fail or reset the next part request.
- Advance the shared mock clock through `/__admin/clock` to expire a presigned URL.
- Object writes, copies, multipart completion, and deletes publish S3-shaped notifications. Configure HTTP sinks through runtime `webhooks` options or the shared webhook admin routes; delivery attempts and retries appear under `/__admin/webhooks`.

The shared runtime also provides health, reset, journal, metrics, timeline, and fault routes. Select isolated state with `x-mockingbird-namespace`, `/ns/<name>`, or a SigV4 access-key mapping.

### Deliberately not modelled

Operations outside the listed Geviti surface, object versioning, ACL/IAM policy evaluation, storage classes, checksums beyond ETags, production quotas, AWS dashboards and billing, virtual-host bucket routing, and real SQS delivery are not modelled. SQS consumers can use the same captured notification payload through a configured HTTP sink.

## API

- `S3API`, `S3APIOptions`: portable Fetch handler and configuration.
- `S3Notification`, `S3Object`, `S3SeedObject`: notification, state, and fixture types.
- `createRuntime`, `S3Runtime`, `S3RuntimeOptions`: full Mockingbird runtime and webhook hub.
- `S3_NAMESPACE`, `S3_PRESETS`, `accessKeyCredential`: constants and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `S3ServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon S3 API Reference](https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html) and [AWS Signature Version 4 query authentication](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html).
