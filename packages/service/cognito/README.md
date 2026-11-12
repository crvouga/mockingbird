# @crvouga/mockingbird-service-cognito

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Cognito User Pools for the AWS SDK and `amazon-cognito-identity-js`. It implements the authentication, user administration, group, federation (including the hosted UI's `/oauth2/authorize` and `/oauth2/token`), recovery, JWT, discovery, and JWKS surface the consumer app uses without contacting AWS.

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

Responses contain SDK-consumed Cognito fields and AWS-shaped exceptions (`__type`, `message`, HTTP status, `x-amzn-requestid`). Tokens are RS256 JWTs with Cognito issuer, subject, `token_use`, timestamps and groups. The ID token adds `aud`, `cognito:username`, email and linked identities; the access token adds `client_id`, `username` and `scope`, and no user attributes, as Cognito does. Discovery and JWKS are at `/<poolId>/.well-known/openid-configuration` and `/<poolId>/.well-known/jwks.json`.

### Hosted UI: `/oauth2/authorize` and `/oauth2/token` (best guess, not oracle-verified)

The hosted-UI domain is the emulator's own origin (plus the `/__admin/ns/<name>` prefix for a non-default namespace), and discovery advertises it as `authorization_endpoint` / `token_endpoint`. Behaviour follows the Cognito developer guide ([authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html), [ID token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html)). No live user pool backs the parity harness, so everything here is a **best guess, not oracle-verified**.

- **App clients.** `appClients: [{ clientId, callbackUrls, clientSecret?, identityProviders?, scopes? }]` (runtime option, or `fixtures.appClients` in a fleet entry), or `POST /__admin/app-clients` at runtime (`GET` lists them; secrets are never returned). The default `clientId` exists with no callback URLs, so register the app's `redirect_uri` before using the hosted UI. `identityProviders` omitted allows every provider name; `scopes` omitted allows the five system scopes. Requested scopes the client does not allow are ignored, and no `scope` grants all allowed ones.
- **`GET /oauth2/authorize`** with `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope`, `nonce`, `identity_provider` (`Google`, `SignInWithApple`, `Facebook`, `LoginWithAmazon`, an OIDC/SAML name, or `COGNITO`/absent), and optional PKCE (`code_challenge_method=S256` only). It renders an account picker of the pool's own users in place of the provider's sign-in page; choosing one posts to `/oauth2/idpresponse` and redirects to `redirect_uri?code=…&state=…`. Codes are single use and expire after five minutes.
- **Federation.** The picked user stands in for the provider account; its provider subject is the subject it is already linked under for that provider, otherwise its `sub`. A native user linked to that subject with `AdminLinkProviderForUser` signs in as itself. Otherwise the first sign-in creates the user `<Provider>_<subject>` (status `EXTERNAL_PROVIDER`, the picked user's attributes copied, an `identities` claim `{userId, providerName, providerType, issuer: null, primary: "true", dateCreated}`); later sign-ins reuse it. Federated users cannot use `USER_PASSWORD_AUTH`. With `identity_provider=COGNITO` (or absent) the picked native user signs in directly, standing in for the username/password page.
- **`POST /oauth2/token`** (form body; `client_secret_basic` or `client_secret_post` when the client has a secret): `authorization_code` returns `access_token`, `id_token` (when `openid` was granted), `refresh_token`, `token_type: "Bearer"`, `expires_in: 3600`; `refresh_token` returns new ID and access tokens without a refresh token. Tokens are signed by the pool's keys with the pool's `iss`; the access token's `scope` is the granted scope and the ID token carries the `nonce`. The refresh token is an ordinary pool refresh token: `InitiateAuth` `REFRESH_TOKEN_AUTH` accepts it (keeping its scopes), and the token endpoint accepts refresh tokens from API sign-ins. Every answer carries `Access-Control-Allow-Origin: *` and `OPTIONS` answers the CORS preflight, as the docs describe.
- **Errors.** An unknown `client_id` or unregistered `redirect_uri` redirects to the hosted UI's `/error?error=invalid_client|redirect_mismatch&client_id=…` page (HTTP 400 HTML), since there is no trusted place to send them. With a valid client and callback, a missing `response_type`, a `code_challenge` without `code_challenge_method`, or a method other than `S256` returns `redirect_uri?error=invalid_request&state=…`; an `identity_provider` the client does not support returns `error=invalid_request` with `Login option is not available. Please try another one`; Cancel on the picker returns `error=access_denied`. The token endpoint answers HTTP 400 `{"error": …}`: `invalid_client` (unknown client or wrong secret), `invalid_grant` (unknown, expired, reused or other-client code; wrong `code_verifier`; revoked, expired or other-client refresh token), `unauthorized_client` with `error_description: "invalid_redirect"` (`redirect_uri` differs from the authorization request, as the token-endpoint docs say), `invalid_request` (missing `code`, `redirect_uri` or `refresh_token`), and `unsupported_grant_type`.
- **Not modelled (explicit errors).** The implicit grant (`response_type=token`) returns `error=unauthorized_client`, `idp_identifier` returns `error=invalid_request`, and `grant_type=client_credentials` returns `unsupported_grant_type` with a description saying the emulator does not model it. Managed-login branding, `prompt`, `login_hint`, `/login`, `/logout`, `/oauth2/userInfo`, real redirects to Google/Apple, and attribute mapping beyond copying the picked user's attributes are not modelled.
- **Headless control.** `POST /__admin/hosted-ui/next-account {"username":"…"}` makes the next `/oauth2/authorize` in that namespace pick that user and redirect at once, so a test completes the flow with plain `fetch`. The pick is consumed by one authorization.

### Admin and deterministic controls

- `GET/POST /__admin/users` lists redacted users or seeds one. Passwords and tokens are never returned.
- `GET /__admin/codes?username=…` returns a user's current confirmation/reset codes; without `username` it is a 400.
- `GET /__admin/outbox` lists every message Cognito delivered, oldest first (filters `to`, `since`, `limit`, `channel` = `email`/`sms`, `trigger`, `username`; `GET /__admin/outbox/:id` reads one). SignUp, ResendConfirmationCode and ForgotPassword send Cognito's default verification message (`no-reply@verificationemail.com`, subject `Your verification code`, body `Your verification code is <code>.`) to the user's `email`, or by SMS to `phone_number` when the user has no email, and `CodeDeliveryDetails` names that medium. AdminCreateUser sends the default invitation (`Your username is <username> and temporary password is <password>.`) over `DesiredDeliveryMediums` (SMS by default, email for a user without `phone_number`) unless `MessageAction` is `SUPPRESS`. Each entry has `to`, `channel`, `deliveryMedium`, `attributeName`, `username`, `trigger`, `code`, `from`, `subject`, `body` and `createdAt`. Custom message templates are not modelled. Run the [notifications harness](../../notifications/README.md) against the pool to see these on a phone and webmail screen and finish sign-up from there.
- `POST /__admin/sessions/revoke {"username":"…"}` invalidates access and refresh sessions.
- `POST /__admin/hosted-ui/next-account {"username":"…"}` picks the hosted UI's next account; `GET/POST /__admin/app-clients` lists or registers hosted-UI app clients.
- `POST /__admin/keys/rotate {"retainPrevious":true}` rotates signing keys and retains at most two prior keys. As in Cognito, ID and access tokens are signed with different keys, so the JWKS lists one key of each kind per generation and rotation replaces both (the response names them `kid` and `accessKid`). Every new key receives a fresh random UUID `kid`, independently of the virtual clock. Reset starts a fresh key ring.
- Fault presets: `throttled`, `unavailable`.

The shared runtime supplies reset, clock, snapshots, journals, metrics, faults, branches, and namespace isolation. Select namespaces through `x-mockingbird-namespace`, `/__admin/ns/<name>`, or SigV4 access-key mappings.

### Fleet fixtures and public identity endpoints

Use `fixtures: { users: [...] }` in a fleet service entry, or `options: { fixtures: "./synthetic-users.json" }` for an explicit JSON file containing the same object. The standalone CLI accepts `--fixtures ./synthetic-users.json`. Each user requires `username` and `password`; optional `sub`, `confirmed`, `enabled`, `status`, `createdAt`, attributes, groups, linked identities and inspection codes match the in-process seed fields. Invalid fields, duplicate usernames/subjects/email aliases and conflicting identities fail with field paths before readiness. Diagnostics omit values. Fixture identity objects accept Cognito identity claim fields and the supported provider-link fields, rather than arbitrary nested objects.

Fixtures form the reset baseline for every independent namespace. Importing a snapshot replaces saved state, including deleted fixture users, without reseeding. Synthetic passwords stay in private state/archives; user admin responses redact passwords, session data and inspection codes. Codes remain available only from `/__admin/codes` and the delivered messages in `/__admin/outbox`.

| Surface | Public origin and path prefix | Namespace isolation |
| --- | --- | --- |
| Unsigned `InitiateAuth` / user-pool JSON operations | Supported | Header and path carriers |
| RS256 issuer, discovery and JWKS | Supported; `publicOrigin` + `publicPath` configure the authoritative base | Advertised URLs carry the selected namespace, including header-selected requests |
| SigV4-signed AWS admin operations | Direct private listener only; signature validation through proxies is not certified | Fixture signatures remain the local test contract |
| Mockingbird admin controls / private signing material | Private listener only | Never routed by the reference public ingress |
| Hosted UI (`/oauth2/authorize`, `/oauth2/idpresponse`, `/oauth2/token`, `/error`) | Supported; redirects and the picker's form use the configured public base | Header and path carriers; picker links carry the namespace prefix |

In-process callers can set `baseUrl`, and the CLI accepts `--base-url`. Fixed configuration determines advertised identity URLs; Host and forwarding headers never override it. Without explicit configuration, the direct request/mount URL supplies the origin. Replacing a fleet behind a stable public endpoint retains the issuer even when private listener ports change.

Current and retained synthetic signing keys live in namespace storage, so namespace snapshots, whole-fleet archives and restored time-travel checkpoints preserve key IDs and pre-snapshot signatures. Subsequent rotation reads the restored ring. Archives created before signing-state persistence contain no recoverable private key; they load with a fresh ring and require reauthentication. Protect portable archives as private synthetic credentials; diagnostic and user-control responses never include key material.

### Deliberately not modelled

Operations outside the documented subset, production quotas, real email/SMS delivery (messages are recorded in `/__admin/outbox` instead), custom message templates, MFA, Lambda triggers, device tracking, Cognito Identity Pools, AWS billing, dashboards, and outbound vendor calls are not implemented. The hosted UI renders an emulator account picker instead of Cognito's managed login pages or the real Google/Apple pages (see Hosted UI above for the unmodelled parameters and grants).

## API

- `CognitoAPI`, `CognitoAPIOptions`: AWS JSON handler and options.
- `createRuntime`, `CognitoRuntime`, `CognitoRuntimeOptions`: full Mockingbird service runtime.
- `COGNITO_NAMESPACE`, `COGNITO_PRESETS`, `accessKeyCredential`: service constants and controls.
- `CognitoAttribute`, `CognitoSeedUser`, `CognitoUser`, `CognitoFixtures`: state and fixture types.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `CognitoServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon Cognito User Pools API Reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/Welcome.html) and [Cognito ID token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html).
