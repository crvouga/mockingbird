# @crvouga/mockingbird-service-step-functions

Stateful, portable AWS Step Functions mock for the official SFN SDK v3 client. It models Standard execution identity, input/output strings, deterministic terminal transitions, callback tokens, stop requests, ordered history, pagination, and shared-clock scripts without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-step-functions
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point the SFN client's `endpoint` option at the mock. Fixture SigV4 credentials are accepted.

```ts
import { createServer } from "@crvouga/mockingbird-service-step-functions/server"

const mock = await createServer({
  stateMachines: [
    {
      name: "jobs",
      scripted: { status: "SUCCEEDED", output: '{"ok":true}', afterMs: 1000 },
    },
  ],
})
const health = await fetch(`${mock.url}/health`)
```

Supported operations are StartExecution, DescribeExecution, StopExecution, GetExecutionHistory, SendTaskSuccess, SendTaskFailure, and SendTaskHeartbeat. Running executions are idempotent by state-machine ARN, name, and exact input. Closed-name reuse and conflicting running input return ExecutionAlreadyExists. JSON input/output remain strings at the wire.

### Admin and deterministic controls

- `GET/POST /__admin/state-machines` lists or registers compact local definitions.
- `GET /__admin/executions` inspects executions with task tokens redacted.
- `GET /__admin/executions/:arn/task-token` retrieves a local callback token.
- `POST /__admin/executions/:arn/transition` deterministically moves a running execution to SUCCEEDED, FAILED, TIMED_OUT, or ABORTED.
- Scripted machines transition when the shared clock reaches `afterMs`; no polling sleep is necessary.
- Fault presets are `throttled` and `unavailable`.

The shared runtime also supplies reset, timeline, journal, metrics, faults, and namespace isolation through `x-mockingbird-namespace`, `/ns/<name>`, or SigV4 access-key mappings.

### Deliberately not modelled

The full Amazon States Language interpreter, real service integrations, Express Workflows, IAM evaluation, CloudWatch delivery, production retention limits, dashboards, and billing are not modelled. Definitions can be retained as fixtures, while deterministic scripts and callback tasks cover the current consumer contract.

## API

- `StepFunctionsAPI`, `StepFunctionsAPIOptions`, `StateMachineSeed`: portable handler and fixtures.
- `Execution`, `ExecutionStatus`, `HistoryEvent`, `StateMachine`: durable workflow state.
- `createRuntime`, `StepFunctionsRuntime`, `StepFunctionsRuntimeOptions`: full Mockingbird runtime.
- `STEP_FUNCTIONS_NAMESPACE`, `STEP_FUNCTIONS_PRESETS`, `accessKeyCredential`: constants and controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `StepFunctionsServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [AWS Step Functions API Reference](https://docs.aws.amazon.com/step-functions/latest/apireference/Welcome.html).
