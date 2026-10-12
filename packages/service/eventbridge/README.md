# @crvouga/mockingbird-service-eventbridge

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP AWS EventBridge control-plane discovery. Seeded rule and target reads use AWS JSON 1.1;
no containers or infrastructure are executed. Follows the official
[ListRules](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_ListRules.html),
[ListTargetsByRule](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_ListTargetsByRule.html)
and [common errors](https://docs.aws.amazon.com/eventbridge/latest/APIReference/CommonErrors.html).

## Install

`bun add @crvouga/mockingbird-service-eventbridge`

## Usage

```ts
import { EventBridgeClient, ListRulesCommand } from "@aws-sdk/client-eventbridge"
import { createServer } from "@crvouga/mockingbird-service-eventbridge/server"

// Test setup: seed a rule, then point the EventBridge client your application already uses
// at the emulator.
const server = await createServer({
  rules: [{ rule: { Name: "nightly", Arn: "arn:aws:events:us-east-1:000000000000:rule/nightly" }, targets: [] }],
})
const eventBridge = new EventBridgeClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code, unchanged.
const { Rules } = await eventBridge.send(new ListRulesCommand({ NamePrefix: "night" }))
// Rules[0].Name === "nightly"

await server.close()
```

CLI: `mockingbird-eventbridge serve --port 12128`. Set your client factory's endpoint_url
or AWS_ENDPOINT_URL_EVENTBRIDGE to that URL. The default instance has no rules.
POST / dispatches X-Amz-Target AWSEvents.ListRules and AWSEvents.ListTargetsByRule.
NamePrefix filters names; Limit (1–100) and NextToken paginate rules and targets.
The terminal page omits NextToken. Missing buses/rules return ResourceNotFoundException (400).

## Controls and state

Seed through options.rules ({rule, targets}) or POST /__admin/state/rules with
{id: "default:nightly", value: {rule: {Name, Arn}, targets: [{Id, Arn, EcsParameters}]}}.
Custom buses must also be seeded in options.buses or /__admin/state/buses ({name}).
The default bus always exists. Rule.EventBusName defaults to default.
Target objects, including TaskDefinitionArn and awsvpcConfiguration, round-trip without execution.
State collections: rules, buses, cursors and initialization marker.
Shared /__admin provides health, state, reset, Timeline checkpoints, clock, journal, metrics and UI.
Namespaces work via x-mockingbird-namespace, /__admin/ns/name and SigV4 access-key mappings
set with PUT /__admin/credentials. No cryptographic signature or IAM evaluation is performed.
The journal records metadata, not request bodies or credentials.

Presets: access_denied (403), throttled (AWS 400), rate_limited (explicit HTTP 429 fault),
internal_error (500), connection_drop. Standard faults support deterministic latency.
No outbound webhooks are emitted.

## Verification

Run `bun test` here for acceptance, JS SDK, self-parity and deliberate divergence tests.
Run `bun scripts/sdk.ts` with uv installed for the separate pinned boto3 1.43.56
drop-in/paginator/error proof (uv obtains that exact package; no AWS credentials are needed).
Live safe empty-prefix discovery: `bun run parity` with EVENTBRIDGE_ACCESS_KEY_ID,
EVENTBRIDGE_SECRET_ACCESS_KEY, optional EVENTBRIDGE_REGION. Missing credentials exit 2.
The SDK tests prove client compatibility, not live AWS equivalence.

## Deliberately not modelled

Rule/target mutation, event delivery, schedules, IAM policy evaluation, cryptographic SigV4
validation, real execution, provisioning and deployment. Seeded resources are fixtures, not
AWS accounts. Cursor strings and their one-hour emulator-clock lifetime are deterministic local
stand-ins; AWS does not document a fixed lifetime or wire token format. Pagination binds
arguments but does not freeze a snapshot of concurrent fixture edits. Result order is fixture
insertion order, not a guarantee about AWS ordering. HTTP 429 is a test fault, not the normal
EventBridge throttling status.

## API

- `EventbridgeAPI`, `createAwsRuntime`, and `createAwsServer` (server entry): separate extended AWS operations runtime.

Main exports: EventBridgeAPI, EVENTBRIDGE_NAMESPACE, createRuntime, EVENTBRIDGE_PRESETS,
document, operationIds, supportedOperationIds.
Types: Rule, Target, SeedRule, EventBridgeAPIOptions, EventBridgeRuntimeOptions, EventBridgeRuntime.
Server entry: createServer, DEFAULT_PORT, serveTarget; type EventBridgeServerOptions.
CLI entry runs the serve command and exports no runtime values.

## Extended AWS operations runtime

`createAwsRuntime` (and `createAwsServer` from the server entry) exposes the additional LocalStack-oriented event bus, rule, target, event ingestion and tagging operations. It has separate state and does not claim the seeded discovery runtime's pagination behavior. The default `createRuntime` retains the documented discovery contract and fixtures. Both modes remain WIP. Run `bun run parity:localstack` for the extended runtime.
