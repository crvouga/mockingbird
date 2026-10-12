# @crvouga/mockingbird-service-scheduler

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon EventBridge Scheduler. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import {
  CreateScheduleCommand,
  GetScheduleCommand,
  SchedulerClient,
} from "@aws-sdk/client-scheduler"
import { createServer } from "@crvouga/mockingbird-service-scheduler/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const scheduler = new SchedulerClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the Scheduler SDK calls it already makes.
await scheduler.send(
  new CreateScheduleCommand({
    Name: "nightly-report",
    ScheduleExpression: "cron(0 2 * * ? *)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: {
      Arn: "arn:aws:lambda:us-east-1:000000000000:function:report",
      RoleArn: "arn:aws:iam::000000000000:role/scheduler",
    },
  }),
)
const schedule = await scheduler.send(new GetScheduleCommand({ Name: "nightly-report" }))
console.log(schedule.State, schedule.ScheduleExpression) // ENABLED cron(0 2 * * ? *)

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateSchedule`, `GetSchedule`, `ListSchedules`, `UpdateSchedule`, `DeleteSchedule`, `CreateScheduleGroup`, `GetScheduleGroup`, `ListScheduleGroups`, `DeleteScheduleGroup`, `TagResource`, `UntagResource`, `ListTagsForResource`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-scheduler
```

## API

- `SchedulerAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
