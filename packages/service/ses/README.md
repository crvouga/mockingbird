# @crvouga/mockingbird-service-ses

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Simple Email Service. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { SendEmailCommand, SESClient, VerifyEmailIdentityCommand } from "@aws-sdk/client-ses"
import { createServer } from "@crvouga/mockingbird-service-ses/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const ses = new SESClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the SES SDK calls it already makes.
await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: "billing@example.com" }))
const sent = await ses.send(
  new SendEmailCommand({
    Source: "billing@example.com",
    Destination: { ToAddresses: ["ada@example.com"] },
    Message: { Subject: { Data: "Receipt" }, Body: { Text: { Data: "Thanks for your order." } } },
  }),
)
console.log(sent.MessageId) // an emulator-issued message id

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `VerifyEmailIdentity`, `VerifyEmailAddress`, `VerifyDomainIdentity`, `DeleteIdentity`, `ListIdentities`, `GetIdentityVerificationAttributes`, `GetSendQuota`, `GetSendStatistics`, `SendEmail`, `SendRawEmail`, `CreateTemplate`, `GetTemplate`, `UpdateTemplate`, `DeleteTemplate`, `ListTemplates`, `CreateConfigurationSet`, `DeleteConfigurationSet`, `ListConfigurationSets`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-ses
```

## API

- `SesAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
