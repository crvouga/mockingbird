# @crvouga/mockingbird-service-aws

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Combined S3 object storage, SQS queues, IAM identities and STS credentials. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-aws
```

## Usage

```ts
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3"
import { createServer } from "@crvouga/mockingbird-service-aws/server"

// Test setup: start the emulator and point the AWS SDK client your application uses at it.
const emulator = await createServer({ seed: 1 })
const s3 = new S3Client({
  endpoint: emulator.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  forcePathStyle: true,
})

// Application code: ordinary SDK calls.
const { Buckets } = await s3.send(new ListBucketsCommand({}))
// Buckets[0].Name === "emulate-default"

await emulator.close() // after the test
```

## API

- `AwsAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `AWS_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
