# @crvouga/mockingbird-service-resource-groups

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Resource Groups. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import {
  CreateGroupCommand,
  GetTagsCommand,
  ResourceGroupsClient,
} from "@aws-sdk/client-resource-groups"
import { createServer } from "@crvouga/mockingbird-service-resource-groups/server"

// Test setup: the Resource Groups client your application already uses, pointed at the emulator.
const server = await createServer()
const resourceGroups = new ResourceGroupsClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code, unchanged.
const { Group } = await resourceGroups.send(
  new CreateGroupCommand({
    Name: "checkout",
    ResourceQuery: {
      Type: "TAG_FILTERS_1_0",
      Query: JSON.stringify({
        ResourceTypeFilters: ["AWS::AllSupported"],
        TagFilters: [{ Key: "team", Values: ["checkout"] }],
      }),
    },
    Tags: { team: "checkout" },
  }),
)
const { Tags } = await resourceGroups.send(new GetTagsCommand({ Arn: Group?.GroupArn }))
// Tags is { team: "checkout" }

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateGroup`, `GetGroup`, `ListGroups`, `UpdateGroup`, `DeleteGroup`, `GetGroupQuery`, `UpdateGroupQuery`, `GetTags`, `Tag`, `Untag`, `ListGroupResources`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-resource-groups
```

## API

- `ResourceGroupsAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
