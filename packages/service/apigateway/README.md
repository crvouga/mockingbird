# @crvouga/mockingbird-service-apigateway

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon API Gateway REST API. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { APIGatewayClient, GetRestApisCommand } from "@aws-sdk/client-api-gateway"
import { createServer } from "@crvouga/mockingbird-service-apigateway/server"

// Test setup: start the emulator and point the AWS SDK client your application uses at it.
const emulator = await createServer()
const apigateway = new APIGatewayClient({
  endpoint: emulator.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// No operation is implemented yet, so every SDK call rejects. The emulator answers 400
// UnknownOperationException as XML, which this REST JSON client reports as a parse error.
const failure = await apigateway.send(new GetRestApisCommand({})).catch((error: Error) => error)
// failure instanceof Error

await emulator.close() // after the test
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `CreateRestApi`, `GetRestApi`, `GetRestApis`, `UpdateRestApi`, `DeleteRestApi`, `GetResources`, `CreateResource`, `GetResource`, `DeleteResource`, `PutMethod`, `GetMethod`, `DeleteMethod`, `PutIntegration`, `GetIntegration`, `DeleteIntegration`, `CreateDeployment`, `GetDeployments`, `CreateStage`, `GetStage`, `GetStages`, `DeleteStage`, `CreateApiKey`, `GetApiKeys`, `DeleteApiKey`, `CreateUsagePlan`, `GetUsagePlans`, `DeleteUsagePlan`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-apigateway
```

## API

- `ApigatewayAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
