# @crvouga/mockingbird-service-cognito

Stateful local mock of Amazon Cognito User Pools for the AWS SDK and `amazon-cognito-identity-js`. It implements the authentication, user administration, group, federation, recovery, JWT, discovery, and JWKS surface the consumer app uses without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-cognito
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point `COGNITO_ENDPOINT` or the AWS SDK `endpoint` option at the served mock. Fixture SigV4 credentials are accepted for admin operations. Public user-pool operations work without IAM credentials, matching Cognito's client-facing API.

```ts
import { createRuntime } from "@crvouga/mockingbird-service-cognito"

const cognito = createRuntime({
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
```

The Node adapter is `createServer()` from `./server`; the CLI is `npx mockingbird-cognito serve --port 8811 --pool-id us-east-1_mockingbird --client-id mockingbird-client`.

### AWS JSON operations

`POST /` dispatches by `X-Amz-Target` and supports SignUp, ConfirmSignUp, ResendConfirmationCode, InitiateAuth (`USER_PASSWORD_AUTH`, `REFRESH_TOKEN_AUTH`), ForgotPassword, ConfirmForgotPassword, ChangePassword, GetUser, DeleteUser, AdminCreateUser, AdminSetUserPassword, AdminConfirmSignUp, AdminGetUser, AdminUpdateUserAttributes, AdminDeleteUser, ListUsers, AdminLinkProviderForUser, AdminAddUserToGroup, AdminRemoveUserFromGroup, and AdminUserGlobalSignOut.

Responses contain SDK-consumed Cognito fields and AWS-shaped exceptions (`__type`, `message`, HTTP status, `x-amzn-requestid`). Tokens are RS256 JWTs with Cognito issuer, subject, client, `token_use`, timestamps, username, email, groups, and linked identities. Discovery and JWKS are at `/<poolId>/.well-known/openid-configuration` and `/<poolId>/.well-known/jwks.json`.

### Admin and deterministic controls

- `GET/POST /__admin/users` lists redacted users or seeds one. Passwords and tokens are never returned.
- `GET /__admin/codes?username=…` returns local confirmation/reset codes without sending mail.
- `POST /__admin/sessions/revoke {"username":"…"}` invalidates access and refresh sessions.
- `POST /__admin/keys/rotate {"retainPrevious":true}` rotates signing keys with optional overlap.
- Fault presets: `throttled`, `unavailable`.

The shared runtime supplies reset, clock, snapshots, journals, metrics, faults, branches, and namespace isolation. Select namespaces through `x-mockingbird-namespace`, `/ns/<name>`, or SigV4 access-key mappings.

### Deliberately not modelled

Operations outside the documented subset, production quotas, email/SMS delivery, MFA, Lambda triggers, device tracking, Cognito Identity Pools, AWS billing, dashboards, and outbound vendor calls are not implemented. Hosted UI federation is represented in linked identity claims; this WIP tier does not render Cognito's hosted login pages.

## API

- `CognitoAPI`, `CognitoAPIOptions`: portable AWS JSON handler and options.
- `createRuntime`, `CognitoRuntime`, `CognitoRuntimeOptions`: full Mockingbird service runtime.
- `COGNITO_NAMESPACE`, `COGNITO_PRESETS`, `accessKeyCredential`: service constants and controls.
- `CognitoAttribute`, `CognitoSeedUser`, `CognitoUser`: state and fixture types.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `CognitoServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon Cognito User Pools API Reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/Welcome.html) and [Cognito ID token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html).
