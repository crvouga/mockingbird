# Amazon Cognito Identity Provider (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **3**
- supported by the mock: **3**
- parity enabled: **1**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `CognitoRpc` | `POST /` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `Discovery` | `GET /{poolId}/.well-known/openid-configuration` | ✅ supported | ❌ disabled | Local issuer metadata. |
| `Jwks` | `GET /{poolId}/.well-known/jwks.json` | ✅ supported | ❌ disabled | Local signing keys. |
