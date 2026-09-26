# @crvouga/mockingbird-service-aws-secrets

Stateful, portable mock of AWS Secrets Manager and SSM Parameter Store for the official AWS SDK v3 clients. It models secret versions and stages, binary values, deterministic rotation, SecureString metadata, parameter versions, denials, decryption failures, and redacted controls without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-aws-secrets
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point both clients' `endpoint` option at the same mock URL. Fixture SigV4 credentials are accepted.

```ts
import { createServer } from "@crvouga/mockingbird-service-aws-secrets/server"

const mock = await createServer({
  secrets: [{ name: "database/password", value: "fixture-password" }],
  parameters: [{ name: "/app/region", value: "us-east-1" }],
})
const health = await fetch(`${mock.url}/health`)
```

Secrets Manager supports CreateSecret, PutSecretValue, GetSecretValue, and DescribeSecret by name or ARN, including VersionId, VersionStage, SecretString, and SecretBinary. SSM supports PutParameter, GetParameter, and GetParameters with String, StringList, SecureString, WithDecryption, versions, ARNs, and data types.

### Admin and deterministic controls

- `GET /__admin/secrets` and `/__admin/parameters` expose metadata with every value redacted.
- `POST /__admin/secrets/:name/rotate` atomically moves AWSCURRENT to AWSPREVIOUS.
- `PUT /__admin/controls/:name` configures denial, stale-version reads, or decryption failure.
- Fault presets are `throttled` and `unavailable`.

Values are encoded in durable state so timelines and snapshots do not contain plaintext markers. Request journals never record request or response bodies. The shared runtime also provides reset, clock, timeline, metrics, faults, and namespace isolation through `x-mockingbird-namespace`, `/ns/<name>`, or SigV4 access-key mappings.

### Deliberately not modelled

KMS cryptography, automatic rotation Lambdas, resource policies, replication, SSM hierarchies and labels beyond the supported reads, production quotas, AWS dashboards, billing, and outbound vendor calls are not modelled. SecureString ciphertext returned without decryption is deterministic mock ciphertext, not KMS output.

## API

- `AwsSecretsAPI`, `AwsSecretsAPIOptions`, `SecretSeed`, `ParameterSeed`: portable handler and fixtures.
- `Secret`, `SecretVersion`, `SecretControl`, `Parameter`: durable state types.
- `createRuntime`, `AwsSecretsRuntime`, `AwsSecretsRuntimeOptions`: full Mockingbird runtime.
- `AWS_SECRETS_NAMESPACE`, `AWS_SECRETS_PRESETS`, `accessKeyCredential`: constants and controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `AwsSecretsServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracles: [AWS Secrets Manager API Reference](https://docs.aws.amazon.com/secretsmanager/latest/apireference/Welcome.html) and [AWS Systems Manager API Reference](https://docs.aws.amazon.com/systems-manager/latest/APIReference/Welcome.html).
