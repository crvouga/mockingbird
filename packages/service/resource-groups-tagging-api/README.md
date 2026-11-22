# @crvouga/mockingbird-service-resource-groups-tagging-api

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Resource Groups Tagging API. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
  TagResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api"
import { createServer } from "@crvouga/mockingbird-service-resource-groups-tagging-api/server"

// Test setup: the tagging client your application already uses, pointed at the emulator.
const server = await createServer()
const tagging = new ResourceGroupsTaggingAPIClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code, unchanged.
await tagging.send(
  new TagResourcesCommand({ ResourceARNList: ["arn:aws:s3:::orders"], Tags: { team: "checkout" } }),
)
const { ResourceTagMappingList } = await tagging.send(
  new GetResourcesCommand({ TagFilters: [{ Key: "team", Values: ["checkout"] }] }),
)
// ResourceTagMappingList[0].ResourceARN === "arn:aws:s3:::orders"

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `TagResources`, `UntagResources`, `GetResources`, `GetTagKeys`, `GetTagValues`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-resource-groups-tagging-api
```

## API

- `ResourceGroupsTaggingApiAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
