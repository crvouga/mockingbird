# MinIO oracle

The S3 emulator's behavior is defined by [MinIO](https://github.com/minio/minio) at
`RELEASE.2025-10-15T17-29-55Z` (the last upstream release; the repository is archived). Every
scenario in `scenarios/` is a deterministic script of S3 requests. Played against MinIO it
produces a transcript — status, headers and body of every exchange — that is recorded under
`golden/`. Played against the emulator it must produce the same transcript, byte for byte, once
volatile values are masked.

```
bun oracle/run.ts                  # MinIO vs emulator, live, every scenario
bun oracle/run.ts objects/ range/  # only scenarios whose name contains a filter
bun oracle/run.ts --show objects/x # print both transcripts in full
bun oracle/run.ts --record auth/   # refresh golden/ from MinIO (never from the emulator)
bun oracle/run.ts --golden         # emulator vs golden/, no MinIO needed
bun test s3.oracle.test.ts         # the same, as part of `bun test`
```

`bun run parity:service -- s3` runs the live comparison. Exit 0 on parity, 1 on a divergence,
2 when MinIO is unreachable.

## Running MinIO

MinIO no longer publishes binaries, so build the pinned release (Go 1.22+, about a minute):

```bash
GOBIN=/tmp/minio-oracle/bin go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z
MINIO_ROOT_USER=mockingbird MINIO_ROOT_PASSWORD=mockingbird-secret MINIO_REGION=us-east-1 \
  /tmp/minio-oracle/bin/minio server /tmp/minio-oracle/data --address 127.0.0.1:9000
```

The harness reads `S3_ORACLE_ENDPOINT` (default `http://127.0.0.1:9000`), `S3_ORACLE_ACCESS_KEY`
/ `S3_ORACLE_SECRET_KEY` (default `mockingbird` / `mockingbird-secret`) and `S3_ORACLE_REGION`
(default `us-east-1`). Use a MinIO you can wipe: scenarios create and destroy buckets, and
ListBuckets scenarios see every bucket on the server. The MinIO source for the pinned release
(`cmd/*-handlers.go`, `cmd/api-errors.go`, `cmd/api-response.go`) is the reference for *why*
MinIO answers as it does; `go install` leaves it under `$(go env GOMODCACHE)/github.com/minio/`.

## Writing scenarios

```ts
import { keyPath, type Scenario } from "../harness.js"

export const scenarios: Scenario[] = [
  {
    name: "range-suffix",
    async run(s) {
      const b = await s.bucket("range")                  // unrecorded setup, cleaned up after
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "0123456789" })
      await s.req("suffix", { method: "GET", path: keyPath(b, "k"), headers: { range: "bytes=-3" } })
    },
  },
]
```

- `s.req` records the exchange; `s.raw` does not (setup). Both return `{ status, headers, text,
  bytes, tag(name), tags(name) }` so a scenario can use an upload id or version id it was given.
- `s.bucket(base, { versioning, objectLock })` makes a bucket unique to the run; `s.name(base)`
  only reserves a name (to test CreateBucket itself). Every such bucket is emptied and deleted
  afterwards, whatever the scenario left behind.
- `auth` on a request: `header` (default, SigV4 over the body hash), `unsigned-payload`,
  `presign`, `anonymous`, `streaming`, `streaming-unsigned-trailer`; plus `date`, `expires`,
  `credentials`, `region`, `tamper` to build wrong requests on purpose.
- `s.sdk()` is an AWS SDK v3 client for the target; record SDK results with `s.record(step,
  value)` and errors with `s.errorName(() => ...)`.
- Paths are already encoded: build them with `keyPath(bucket, key)`.
- Masked in transcripts: request ids, host ids, `Date`/`Server`/rate-limit headers, timestamps
  (`LastModified`, `CreationDate`, `Initiated`, `Last-Modified`), and server-generated ids (upload
  ids, version ids, continuation tokens: each becomes `<id:N>` in order of first appearance, so a
  scenario must use them consistently). The per-run bucket suffix becomes `<run>`. Everything else
  — status, every other header, the exact XML — must match.
- A scenario must be deterministic: no wall-clock dependence (use dates far in the past or
  future), no randomness, no SSE-C (MinIO requires TLS for it), no KMS.

## Where the emulator departs from MinIO

The emulator is a superset, never a subset. Where MinIO only stubs an API that Amazon S3
implements, the emulator keeps the AWS behavior and the area is not in the golden transcripts:

- **Bucket CORS** (`PutBucketCors` is NotImplemented in MinIO): AWS rules, see `../README.md`.
