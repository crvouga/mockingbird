# @crvouga/mockingbird-service-kms

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Key Management Service. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { CreateKeyCommand, DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms"
import { createServer } from "@crvouga/mockingbird-service-kms/server"

// Test setup: the KMS client your application already uses, pointed at the emulator.
const server = await createServer()
const kms = new KMSClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code, unchanged.
const { KeyMetadata } = await kms.send(new CreateKeyCommand({ Description: "orders" }))
const { CiphertextBlob } = await kms.send(
  new EncryptCommand({ KeyId: KeyMetadata?.KeyId, Plaintext: new TextEncoder().encode("secret") }),
)
const { Plaintext } = await kms.send(new DecryptCommand({ CiphertextBlob }))
// new TextDecoder().decode(Plaintext) === "secret"

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateKey`, `DescribeKey`, `ListKeys`, `EnableKey`, `DisableKey`, `ScheduleKeyDeletion`, `CancelKeyDeletion`, `CreateAlias`, `UpdateAlias`, `DeleteAlias`, `ListAliases`, `Encrypt`, `Decrypt`, `ReEncrypt`, `GenerateDataKey`, `GenerateDataKeyWithoutPlaintext`, `GetKeyPolicy`, `PutKeyPolicy`, `ListKeyPolicies`, `EnableKeyRotation`, `DisableKeyRotation`, `GetKeyRotationStatus`, `TagResource`, `UntagResource`, `ListResourceTags`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-kms
```

## API

- `KmsAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
