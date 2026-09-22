# Mockingbird OAuth & Social Login — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **32**
- supported by the mock: **32**
- parity enabled: **4**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `Discovery` | `GET /.well-known/openid-configuration` | ✅ supported | ✅ | Google, Apple and Microsoft discovery metadata is checked against their public live endpoints by scripts/parity.ts. |
| `Jwks` | `GET /jwks` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `Authorize` | `GET /authorize` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `InteractionPage` | `GET /interaction` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `Interact` | `POST /interaction` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `Token` | `POST /token` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `UserInfo` | `GET /userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `UserInfoPost` | `POST /userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `Revoke` | `POST /revoke` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GoogleAuthorize` | `GET /o/oauth2/v2/auth` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GoogleLegacyAuthorize` | `GET /o/oauth2/auth` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `AppleAuthorize` | `GET /auth/authorize` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `AppleToken` | `POST /auth/token` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `AppleKeys` | `GET /auth/keys` | ✅ supported | ✅ | Apple's public signing-key contract is checked by scripts/parity.ts. |
| `GoogleKeys` | `GET /oauth2/v3/certs` | ✅ supported | ✅ | Google's public signing-key contract is checked by scripts/parity.ts. |
| `GoogleUserInfo` | `GET /v1/userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GoogleUserInfoPost` | `POST /v1/userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GoogleV3UserInfo` | `GET /oauth2/v3/userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GoogleV3UserInfoPost` | `POST /oauth2/v3/userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `AppleRevoke` | `POST /auth/revoke` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `MicrosoftAuthorize` | `GET /oauth2/v2.0/authorize` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `MicrosoftToken` | `POST /oauth2/v2.0/token` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `MicrosoftKeys` | `GET /discovery/v2.0/keys` | ✅ supported | ✅ | Microsoft's public signing-key contract is checked by scripts/parity.ts. |
| `MicrosoftUserInfo` | `GET /oidc/userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `MicrosoftUserInfoPost` | `POST /oidc/userinfo` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GitHubAuthorize` | `GET /login/oauth/authorize` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GitHubToken` | `POST /login/oauth/access_token` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GitHubUser` | `GET /user` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GitHubUserPost` | `POST /user` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GitHubEmails` | `GET /user/emails` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `GitHubEmailsPost` | `POST /user/emails` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
| `Welcome` | `GET /` | ✅ supported | ❌ disabled | Interactive OAuth transactions are exercised by protocol and independent JOSE tests. |
