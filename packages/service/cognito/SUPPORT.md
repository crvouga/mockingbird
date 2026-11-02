# Amazon Cognito Identity Provider (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **3**
- supported by the emulator: **3**
- parity enabled: **1**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `CognitoRpc` | `POST /` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `Discovery` | `GET /{poolId}/.well-known/openid-configuration` | ✅ supported | ❌ disabled | Namespace-scoped local issuer metadata with configured public origin/prefix. |
| `Jwks` | `GET /{poolId}/.well-known/jwks.json` | ✅ supported | ❌ disabled | Namespace-scoped RS256 keys; one key signs ID tokens and another signs access tokens as in Cognito; portable snapshots retain the current pair and two prior pairs. |
