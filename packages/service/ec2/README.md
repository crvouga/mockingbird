# @crvouga/mockingbird-service-ec2

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon Elastic Compute Cloud. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2"
import { createServer } from "@crvouga/mockingbird-service-ec2/server"

// Test setup: the EC2 client your application already uses, pointed at the emulator.
const server = await createServer()
const ec2 = new EC2Client({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// No EC2 operation is implemented yet, so every command rejects.
const failure = await ec2.send(new DescribeInstancesCommand({})).catch((error: Error) => error.name)
// "UnknownOperationException"

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `RunInstances`, `DescribeInstances`, `StartInstances`, `StopInstances`, `RebootInstances`, `TerminateInstances`, `CreateVpc`, `DescribeVpcs`, `DeleteVpc`, `CreateSubnet`, `DescribeSubnets`, `DeleteSubnet`, `CreateSecurityGroup`, `DescribeSecurityGroups`, `DeleteSecurityGroup`, `AuthorizeSecurityGroupIngress`, `RevokeSecurityGroupIngress`, `CreateTags`, `DeleteTags`, `DescribeTags`, `CreateKeyPair`, `DescribeKeyPairs`, `DeleteKeyPair`, `CreateVolume`, `DescribeVolumes`, `DeleteVolume`, `AttachVolume`, `DetachVolume`, `CreateSnapshot`, `DescribeSnapshots`, `DeleteSnapshot`, `CreateInternetGateway`, `DescribeInternetGateways`, `AttachInternetGateway`, `DetachInternetGateway`, `DeleteInternetGateway`, `CreateRouteTable`, `DescribeRouteTables`, `DeleteRouteTable`, `CreateRoute`, `AssociateRouteTable`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-ec2
```

## API

- `Ec2API(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
