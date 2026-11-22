# @crvouga/mockingbird-service-ecs

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP AWS ECS Fargate RunTask control-plane emulator. It records task acceptance; it never starts
containers. Wire contract follows [RunTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html).

## Install

`bun add @crvouga/mockingbird-service-ecs`

## Usage

```ts
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs"
import { createServer } from "@crvouga/mockingbird-service-ecs/server"

// Test setup: the ECS client your application already uses, pointed at the emulator.
const server = await createServer()
const ecs = new ECSClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code, unchanged. Cluster default and task definition fixture:1 are the fixtures.
const { tasks, failures } = await ecs.send(
  new RunTaskCommand({
    cluster: "default",
    taskDefinition: "fixture:1",
    launchType: "FARGATE",
    networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-fixture"] } },
  }),
)
// tasks[0].lastStatus === "PROVISIONING"; failures is []

await server.close()
```

CLI: `mockingbird-ecs serve --port 12129`. Point the application factory's endpoint_url or
AWS_ENDPOINT_URL_ECS at the server. POST / with X-Amz-Target
AmazonEC2ContainerServiceV20141113.RunTask accepts AWS JSON 1.1.
The default fixtures are cluster default and task definition fixture:1 with container app.
Send launchType FARGATE, taskDefinition, count (1–10), networkConfiguration.awsvpcConfiguration
and optional overrides.containerOverrides. Responses separate tasks from failures.
Cluster name/ARN and task-definition ARN/family:revision/latest active family resolve seeded resources.
Missing clusters return ClusterNotFoundException; absent definitions return ClientException.
Overrides are retained only in task state, not the request journal. Use synthetic fixture values only.

## Controls and state

Options clusters and taskDefinitions replace the default fixtures. Their records are the exported
Cluster and TaskDefinition types. The shared /__admin/state routes also seed these collections.
Read accepted tasks from tasks and request metadata (network configuration, task ARNs, failures)
from requests. Seed placementFailures with AWS Failure objects to script partial placement:
each RunTask takes up to count failures in insertion order and accepts the remaining task count.
Failures persist until deleted/reset; this is a test control, not a capacity simulator.
Tasks remain PROVISIONING with desiredStatus RUNNING; createdAt uses the emulator clock.
Identical clientToken retries within a cluster return the same result for 24 hours;
changed parameters return ConflictException with associated resourceIds. Tokens are resettable state.

Shared /__admin provides health, UI, state, reset, Timeline checkpoints, clock, journal and metrics.
Namespace carriers: x-mockingbird-namespace, /__admin/ns/name and SigV4 access-key mappings via
PUT /__admin/credentials. Signature verification and IAM policy evaluation are not performed.
Journal entries omit bodies and credentials. No webhooks are emitted.
Presets: access_denied (AWS 400), throttled (400), rate_limited (explicit HTTP 429 test fault),
internal_error (500), connection_drop. Shared faults also support deterministic latency.

## Verification

`bun test` runs acceptance and OpenAPI-driven self-parity with divergence detection.
`bun scripts/sdk.ts` uses uv to install and run exact boto3 1.43.56 against the served emulator:
successful RunTask, preserved overrides, idempotency, missing resources and SDK exceptions.
This proves SDK compatibility, not live AWS equivalence. `bun run parity` exits 2 because this
package only models a billable compute-creating operation; no live request is issued implicitly.
Live validation needs an authorized isolated ECS account/cluster and explicit execution approval.

## Deliberately not modelled

Real container execution, task lifecycle progression, eventual consistency, network provisioning,
IAM/signature evaluation, infrastructure deployment, EC2/EXTERNAL/capacity-provider launch modes,
task-definition or cluster mutations and other ECS operations. Nested overrides outside names,
commands and environment are passed through, not comprehensively validated. No subnet reachability,
image validity or resource-capacity simulation. Fargate is the only modeled launch type.
Task ids and platformVersion LATEST are local stand-ins, not exact AWS-generated ids/resolved versions.
The idempotency lifetime is 24 hours while emulator tasks remain uncompleted; shorter post-stop expiry
and task-stop response rewriting are outside this surface.

## API

Main runtime exports: ECSAPI, ECS_NAMESPACE, DEFAULT_CLUSTER, DEFAULT_TASK_DEFINITION,
createRuntime, ECS_PRESETS, document, operationIds, supportedOperationIds.
Types: Cluster, TaskDefinition, Failure, Task, ECSAPIOptions, ECSRuntimeOptions, ECSRuntime.
Server entry: createServer, DEFAULT_PORT, serveTarget; type ECSServerOptions.
CLI entry executes serve and exports no runtime values.
