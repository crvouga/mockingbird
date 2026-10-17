# @crvouga/mockingbird-service-cognito

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Cognito User Pools for the AWS SDK and `amazon-cognito-identity-js`. It implements the authentication, user administration, group, federation, recovery, JWT, discovery, and JWKS surface the consumer app uses without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-cognito
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point `COGNITO_ENDPOINT` or the AWS SDK `endpoint` option at the served emulator. Fixture SigV4 credentials are accepted for admin operations. Public user-pool operations work without IAM credentials, matching Cognito's client-facing API.

```ts
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider"
import { createServer } from "@crvouga/mockingbird-service-cognito/server"

// Test setup: seed the emulator and point the AWS SDK client your application uses at it.
const emulator = await createServer({
  poolId: "us-east-1_mockingbird",
  clientId: "mockingbird-client",
  users: [
    {
      username: "ada@example.test",
      password: "Password1",
      confirmed: true,
      attributes: [{ Name: "email", Value: "ada@example.test" }],
    },
  ],
})
const cognito = new CognitoIdentityProviderClient({
  endpoint: emulator.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: ordinary SDK calls.
const { AuthenticationResult } = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: "mockingbird-client",
    AuthParameters: { USERNAME: "ada@example.test", PASSWORD: "Password1" },
  }),
)
// AuthenticationResult: { AccessToken, IdToken, RefreshToken, ExpiresIn, TokenType }

await emulator.close() // after the test
```

`createServer()` from `./server` is the Node adapter; `createRuntime()` takes the same options in process. The CLI is `npx mockingbird-cognito serve --port 8811 --pool-id us-east-1_mockingbird --client-id mockingbird-client`.

### AWS JSON operations

`POST /` dispatches by `X-Amz-Target` and supports SignUp, ConfirmSignUp, ResendConfirmationCode, InitiateAuth (`USER_PASSWORD_AUTH`, `REFRESH_TOKEN_AUTH`), ForgotPassword, ConfirmForgotPassword, ChangePassword, GetUser, DeleteUser, AdminCreateUser, AdminSetUserPassword, AdminConfirmSignUp, AdminGetUser, AdminUpdateUserAttributes, AdminDeleteUser, ListUsers, AdminLinkProviderForUser, AdminAddUserToGroup, AdminRemoveUserFromGroup, and AdminUserGlobalSignOut.

Responses contain SDK-consumed Cognito fields and AWS-shaped exceptions (`__type`, `message`, HTTP status, `x-amzn-requestid`). Tokens are RS256 JWTs with Cognito issuer, subject, client, `token_use`, timestamps, username, email, groups, and linked identities. Discovery and JWKS are at `/<poolId>/.well-known/openid-configuration` and `/<poolId>/.well-known/jwks.json`.

### Admin and deterministic controls

- `GET/POST /__admin/users` lists redacted users or seeds one. Passwords and tokens are never returned.
- `GET /__admin/codes?username=…` returns local confirmation/reset codes without sending mail.
- `POST /__admin/sessions/revoke {"username":"…"}` invalidates access and refresh sessions.
- `POST /__admin/keys/rotate {"retainPrevious":true}` rotates signing keys and retains at most two prior keys. Every new key receives a fresh random UUID `kid`, independently of the virtual clock. Reset starts a fresh key ring.
- Fault presets: `throttled`, `unavailable`.

The shared runtime supplies reset, clock, snapshots, journals, metrics, faults, branches, and namespace isolation. Select namespaces through `x-mockingbird-namespace`, `/__admin/ns/<name>`, or SigV4 access-key mappings.

### Fleet fixtures and public identity endpoints

Use `fixtures: { users: [...] }` in a fleet service entry, or `options: { fixtures: "./synthetic-users.json" }` for an explicit JSON file containing the same object. The standalone CLI accepts `--fixtures ./synthetic-users.json`. Each user requires `username` and `password`; optional `sub`, `confirmed`, `enabled`, `status`, `createdAt`, attributes, groups, linked identities and inspection codes match the in-process seed fields. Invalid fields, duplicate usernames/subjects/email aliases and conflicting identities fail with field paths before readiness. Diagnostics omit values. Fixture identity objects accept Cognito identity claim fields and the supported provider-link fields, rather than arbitrary nested objects.

Fixtures form the reset baseline for every independent namespace. Importing a snapshot replaces saved state, including deleted fixture users, without reseeding. Synthetic passwords stay in private state/archives; user admin responses redact passwords, session data and inspection codes. Codes remain available only from `/__admin/codes`.

| Surface | Public origin and path prefix | Namespace isolation |
| --- | --- | --- |
| Unsigned `InitiateAuth` / user-pool JSON operations | Supported | Header and path carriers |
| RS256 issuer, discovery and JWKS | Supported; `publicOrigin` + `publicPath` configure the authoritative base | Advertised URLs carry the selected namespace, including header-selected requests |
| SigV4-signed AWS admin operations | Direct private listener only; signature validation through proxies is not certified | Fixture signatures remain the local test contract |
| Mockingbird admin controls / private signing material | Private listener only | Never routed by the reference public ingress |
| Hosted authorization/token UI | Not implemented | Discovery metadata does not imply hosted OAuth flow support |

In-process callers can set `baseUrl`, and the CLI accepts `--base-url`. Fixed configuration determines advertised identity URLs; Host and forwarding headers never override it. Without explicit configuration, the direct request/mount URL supplies the origin. Replacing a fleet behind a stable public endpoint retains the issuer even when private listener ports change.

Current and retained synthetic signing keys live in namespace storage, so namespace snapshots, whole-fleet archives and restored time-travel checkpoints preserve key IDs and pre-snapshot signatures. Subsequent rotation reads the restored ring. Archives created before signing-state persistence contain no recoverable private key; they load with a fresh ring and require reauthentication. Protect portable archives as private synthetic credentials; diagnostic and user-control responses never include key material.

### Deliberately not modelled

Operations outside the documented subset, production quotas, email/SMS delivery, MFA, Lambda triggers, device tracking, Cognito Identity Pools, AWS billing, dashboards, and outbound vendor calls are not implemented. Hosted UI federation is represented in linked identity claims; this WIP tier does not render Cognito's hosted login pages.

## API

- `CognitoAPI`, `CognitoAPIOptions`: AWS JSON handler and options.
- `createRuntime`, `CognitoRuntime`, `CognitoRuntimeOptions`: full Mockingbird service runtime.
- `COGNITO_NAMESPACE`, `COGNITO_PRESETS`, `accessKeyCredential`: service constants and controls.
- `CognitoAttribute`, `CognitoSeedUser`, `CognitoUser`, `CognitoFixtures`: state and fixture types.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `CognitoServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon Cognito User Pools API Reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/Welcome.html) and [Cognito ID token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html).
