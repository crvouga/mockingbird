# Amazon Cognito Identity Provider (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the emulator: **8**
- parity enabled: **1**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `CognitoRpc` | `POST /` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `Discovery` | `GET /{poolId}/.well-known/openid-configuration` | ✅ supported | ❌ disabled | Namespace-scoped local issuer metadata with configured public origin/prefix. |
| `Jwks` | `GET /{poolId}/.well-known/jwks.json` | ✅ supported | ❌ disabled | Namespace-scoped RS256 keys; one key signs ID tokens and another signs access tokens as in Cognito; portable snapshots retain the current pair and two prior pairs. |
| `HostedAuthorize` | `GET /oauth2/authorize` | ✅ supported | ❌ disabled | Best guess from the Cognito docs, not oracle-verified; browser redirect flow with an emulator-rendered account picker. |
| `HostedIdpResponse` | `POST /oauth2/idpresponse` | ✅ supported | ❌ disabled | Emulator-only stand-in for the provider callback; best guess, not oracle-verified. |
| `HostedToken` | `POST /oauth2/token` | ✅ supported | ❌ disabled | Best guess from the Cognito docs, not oracle-verified; client_credentials is not modelled (unsupported_grant_type). |
| `HostedTokenPreflight` | `OPTIONS /oauth2/token` | ✅ supported | ❌ disabled | CORS preflight. |
| `HostedError` | `GET /error` | ✅ supported | ❌ disabled | Static error page. |
