# @crvouga/mockingbird-service-vercel-blob

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A **wip** portable Vercel Blob emulator verified with the unmodified `@vercel/blob` **2.8.0** SDK.
Blobs, multipart uploads, pending parts and synthetic download grants use SQLite Collections,
the shared clock, namespaces and Timeline. Fixtures contain synthetic data only.

## Install

```sh
bun add @crvouga/mockingbird-service-vercel-blob
```

## Usage

The example uses `@vercel/blob@2.8.0`. It is an optional consumer dependency, not a runtime
dependency of the emulator.

```ts
import { del, put } from "@vercel/blob"
import { createServer } from "@crvouga/mockingbird-service-vercel-blob/server"
import { DEFAULT_TOKEN } from "@crvouga/mockingbird-service-vercel-blob"

// Test setup: the emulator, and the two variables the Blob SDK reads.
const server = await createServer()
process.env.VERCEL_BLOB_API_URL = `${server.url}/api/blob`
process.env.BLOB_READ_WRITE_TOKEN = DEFAULT_TOKEN

// The app's own Blob calls, unchanged.
const blob = await put("fixture.txt", "fixture bytes", { access: "public", addRandomSuffix: false })
console.log(await (await fetch(blob.url)).text()) // "fixture bytes"
await del(blob.url)
await server.close()
```

The SDK's supported endpoint override is `VERCEL_BLOB_API_URL` (or
`NEXT_PUBLIC_VERCEL_BLOB_API_URL`). An application's `BLOB_STORE_BASE_URL` must be mapped to that
SDK override by the application. For namespace `suite`, use
`${server.url}/__admin/ns/suite/api/blob`, an `x-mockingbird-namespace: suite` header, or register
the fixture token with `PUT /__admin/credentials`. Every namespace starts empty unless
`fixtures: [{ pathname, bytes: string | number[], contentType?, cacheControlMaxAge?, storeId? }]`
is supplied. `tokens` maps synthetic Bearer tokens to store IDs; the default `DEFAULT_TOKEN`
(`vercel_blob_rw_fixture_fixture`) maps to `fixture`. Invalid or missing tokens return vendor
`403 { error: { code: "forbidden", message: "Access denied" } }`.

The SDK accepts strings, Buffer, Blob and streams. Its multipart helper does not accept a raw
`Uint8Array` as a typed `PutBody`; wrap it in a Blob or Buffer. The emulator's HTTP upload handler
preserves raw `Uint8Array` request bodies as well as strings and arbitrary binary bytes.

## Routes and behavior

| Operation | SDK wire endpoint | Behavior |
| --- | --- | --- |
| PutBlob | `PUT /api/blob/?pathname=…` | Raw bytes; public access, content type, cache TTL, optional random suffix, overwrite and ETag preconditions |
| ReadBlobStore | `GET /api/blob?url=…` | `head()` metadata, size, ETag and upload timestamp |
| ReadBlobStore | `GET /api/blob?prefix=…&limit=…&cursor=…&mode=…` | `list()` with lexical pathname ordering and expanded/folded folders |
| CopyBlob | `PUT /api/blob?pathname=…&fromUrl=…` | Same-store copy; destination content type inferred independently unless supplied |
| DeleteBlobs | `POST /api/blob/delete` | `{ urls: [...] }`; accepts own returned URL or pathname; missing blobs are ignored |
| MultipartUpload | `POST /api/blob/mpu?pathname=…` | `x-mpu-action: create/upload/complete`, SDK key/upload-ID/part-number headers |
| DownloadBlob / HeadDownload | `GET /__admin/blobs/{id}` / `HEAD` | Synthetic public byte transport; exact bytes, ETag, Content-Length/Type, cache and download disposition |

`put()` and `copy()` return `{ pathname, url, downloadUrl, contentType, contentDisposition, etag }`.
The upload reply does **not** contain size; `head()` and list metadata contain it. A duplicate
pathname without overwrite returns vendor `400 bad_request` and leaves the existing bytes intact.
Overwrite replaces the object atomically and preserves its URL. Conditional writes/deletes use
`x-if-match` and return `412 precondition_failed` on a stale ETag; copy checks its **source** ETag.
Deletes validate all preconditions before any removal. No vendor request-ID deduplication is
invented: normal duplicate-path rules apply to repeated puts. ETags use SHA-256, as in Vercel's
published emulator; timestamps use the injected clock. Default cache TTL is 2,592,000 seconds.

Pagination defaults to 1,000 objects, sorts by pathname (so `file10` precedes `file2`) and emits
`hasMore` plus a cursor only when another page exists. Emulator cursors use the last pathname, following
Vercel's emulator; their encoding is not a claim about production's opaque cursor format. Folded
mode returns immediate folders separately from blob entries.

Multipart staging never publishes a partial object. Re-uploading a part number replaces that
pending part. Completion verifies part ETags, ascending unique numbers, total size, and the
documented minimum 5 MiB/equal sizes for all parts except the last, then publishes atomically.
An identical completion replay returns the existing upload result. `maxBlobBytes` defaults to
20 MiB and can be configured: this is an explicit local resource bound, not a production quota.

Public URLs use the configured `publicOrigin` or the origin of the upload request. They contain
an explicit namespace query and point inside the reserved internal byte transport tree. They
work through plain `fetch` over the served listener or in-process `emulator.fetch`. With a custom
`adminPrefix`, the byte URLs and every control route relocate together. A Timeline branch caller
must also forward `x-mockingbird-branch` when fetching its public URL. Conditional public reads
support `If-None-Match` / 304. This local URL transport is a stand-in, not a Vercel CDN hostname.
The SDK's `get()` validates the production hostname, so use plain `fetch` for local downloads.

## Controls and failures

All service controls live beside the shared `/__admin/health`, `/__admin/state`, `/__admin/clock`,
`/__admin/reset`, `/__admin/requests`, fault engine and Timeline controls. `adminKey` uses the
shared `x-mockingbird-admin-key` guard when configured. The journal records metadata and touched
IDs, never upload bodies.

| Control | Purpose |
| --- | --- |
| `GET /__admin/store/blobs` | Blob metadata, excluding bytes |
| `POST /__admin/store/blobs` | Seed `{ pathname, bytes: string \| number[], contentType?, cacheControlMaxAge?, storeId? }` |
| `GET /__admin/store/blobs/:id/bytes` | Explicit fixture byte read |
| `GET /__admin/store/uploads` | Pending/completed upload and part metadata, excluding bytes |
| `POST /__admin/store/origin` | Set `{ origin }` for subsequent uploads and fixture seeds |
| `POST /__admin/store/downloads` | Create a synthetic `{ blobId, expiresInMs }` download grant |
| `POST /__admin/store/downloads/:id/expire` | Expire a grant immediately |

Synthetic grant URLs expire on the shared clock and return 403 after expiry; ordinary public
URLs remain public. These controls do not model a production signing protocol. Presets:
`conflict`, `rate_limited` (429 / Retry-After), `truncated_upload`, `partial_multipart`,
`server_error` and `network_reset`. Each fires once. Activate `partial_multipart` after creating
an upload and before sending the part to fail; earlier parts remain available for retry.

## API

The portable root exports `VercelBlobAPI`, `createRuntime`, `document`, `supportedOperationIds`,
`VERCEL_BLOB_NAMESPACE`, `VERCEL_BLOB_PRESETS`, `DEFAULT_TOKEN`, `DEFAULT_STORE_ID` and
`DEFAULT_CACHE_MAX_AGE`, plus the fixture/record/upload/grant/runtime option types.
`VercelBlobAPI` exposes `fetch`, `reset`, `state`, `metadata`, `seed`, `ensureSeeded`, `app` and
`sqlite`. `createRuntime` adds the shared MockSurface clock, fault engine, journal, credential
registry, state, namespaces and Timeline controls. The Node `./server` entry exports
`createServer`, `DEFAULT_PORT` (8812), `serveTarget` and server types; `mockingbird-vercel-blob
serve` starts a listener.

## Oracle and verification

The contract follows [Vercel's SDK documentation](https://vercel.com/docs/vercel-blob/using-blob-sdk),
the published [official SDK 2.8.0](https://www.npmjs.com/package/@vercel/blob/v/2.8.0), and
[Vercel's official emulator Blob routes at e4cd051](https://github.com/vercel-labs/emulate/blob/e4cd051330282a2ffc615f23d0f03c57bbd65a1e/packages/%40emulators/vercel/src/routes/blob.ts).
The emulator supplies wire/error/list evidence; it explicitly does **not** implement multipart,
which is verified here with the real SDK and the SDK documentation's multipart rules.

`bun test` runs SDK, binary acceptance, all parity-enabled JSON operation walks, a divergent
instance check, namespace/reset/clock/Timeline and catalog preset tests. The served SDK tests run
`put → public GET → overwrite → del` and manual/automatic multipart against this package,
without modifying the SDK or contacting Vercel. Two-part acceptance verifies that failed parts
leave earlier parts intact and that only validated completion makes the object visible.
`bun run parity` is cold
and read-only: `VERCEL_BLOB_API_URL` and `VERCEL_BLOB_READ_WRITE_TOKEN` must name an empty test
store. Missing credentials or a nonempty/inaccessible store exit 2, never a passing live result.

## Deliberately not modelled

Private stores and their authorization, client upload token signing, production CDN/domain
routing, SDK `get()` production-host validation bypass, range requests, image optimization,
provider quotas, cross-store copies, real billing and dashboards, production opaque cursor
encoding and undocumented request-ID deduplication are not modelled. Grants are synthetic
clock controls. This package never contacts Vercel during normal operation; only the explicit
credentialed, read-only parity command does so.
