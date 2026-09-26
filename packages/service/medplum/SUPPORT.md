# Medplum API (Mockingbird contract) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **52**
- supported by the mock: **52**
- parity enabled: **5**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GetRoot` | `GET /` | ✅ supported | ❌ disabled | Static server root; covered by the server scenarios. |
| `GetHealthcheck` | `GET /healthcheck` | ✅ supported | ❌ disabled | Reports the host (platform, runtime) the server runs on. |
| `GetRobots` | `GET /robots.txt` | ✅ supported | ❌ disabled | Static text; covered by the server scenarios. |
| `GetJwks` | `GET /.well-known/jwks.json` | ✅ supported | ❌ disabled | Signing keys are generated per server. |
| `GetOpenIdConfiguration` | `GET /.well-known/openid-configuration` | ✅ supported | ❌ disabled | Discovery document; endpoints are the server's own. |
| `GetSmartConfiguration` | `GET /.well-known/smart-configuration` | ✅ supported | ❌ disabled | Discovery document; endpoints are the server's own. |
| `PostAuthLogin` | `POST /auth/login` | ✅ supported | ❌ disabled | Password flows are covered by the auth scenarios. |
| `PostAuthProfile` | `POST /auth/profile` | ✅ supported | ❌ disabled | Multi-membership login step. |
| `GetAuthMe` | `GET /auth/me` | ✅ supported | ❌ disabled | Covered by the auth and admin scenarios. |
| `PostOauth2Token` | `POST /oauth2/token` | ✅ supported | ❌ disabled | Tokens are minted per call; covered by the auth scenarios. |
| `GetOauth2UserInfo` | `GET /oauth2/userinfo` | ✅ supported | ❌ disabled | Covered by the auth scenarios. |
| `PostOauth2UserInfo` | `POST /oauth2/userinfo` | ✅ supported | ❌ disabled | Covered by the auth scenarios. |
| `GetOauth2Logout` | `GET /oauth2/logout` | ✅ supported | ❌ disabled | Revokes the caller's login. |
| `PostOauth2Logout` | `POST /oauth2/logout` | ✅ supported | ❌ disabled | Revokes the caller's login. |
| `GetAdminProject` | `GET /admin/projects/{projectId}` | ✅ supported | ❌ disabled | Project admins only; covered by the admin scenarios. |
| `PostAdminProjectClient` | `POST /admin/projects/{projectId}/client` | ✅ supported | ❌ disabled | Creates credentials; covered by the admin scenarios. |
| `PostAdminProjectInvite` | `POST /admin/projects/{projectId}/invite` | ✅ supported | ❌ disabled | Creates users; covered by the admin scenarios. |
| `PostAdminProjectSettings` | `POST /admin/projects/{projectId}/settings` | ✅ supported | ❌ disabled | Rewrites the caller's project. |
| `PostAdminProjectSecrets` | `POST /admin/projects/{projectId}/secrets` | ✅ supported | ❌ disabled | Rewrites the caller's project. |
| `PostAdminProjectSites` | `POST /admin/projects/{projectId}/sites` | ✅ supported | ❌ disabled | Rewrites the caller's project. |
| `GetAdminProjectMember` | `GET /admin/projects/{projectId}/members/{membershipId}` | ✅ supported | ❌ disabled | Covered by the admin scenarios. |
| `PostAdminProjectMember` | `POST /admin/projects/{projectId}/members/{membershipId}` | ✅ supported | ❌ disabled | Rewrites a membership. |
| `DeleteAdminProjectMember` | `DELETE /admin/projects/{projectId}/members/{membershipId}` | ✅ supported | ❌ disabled | Removes a member (and a project-scoped user). |
| `GetStorageBinary` | `GET /storage/{binaryId}/{versionId}` | ✅ supported | ❌ disabled | Presigned URLs carry a per-server signature; covered by the binary scenario. |
| `FhirSearchSystem` | `GET /fhir/R4` | ✅ supported | ❌ disabled | Covered by the search scenarios. |
| `FhirBatch` | `POST /fhir/R4` | ✅ supported | ❌ disabled | Covered by the batch and transaction scenarios. |
| `FhirCapabilities` | `GET /fhir/R4/metadata` | ✅ supported | ❌ disabled | Covered by the auth scenarios (compared in full). |
| `FhirGraphql` | `POST /fhir/R4/$graphql` | ✅ supported | ❌ disabled | Covered by the graphql scenario. |
| `FhirBinaryUpload` | `POST /fhir/R4/Binary` | ✅ supported | ❌ disabled | Covered by the binary scenario. |
| `FhirBinaryRead` | `GET /fhir/R4/Binary/{id}` | ✅ supported | ❌ disabled | Covered by the binary scenario. |
| `FhirBinaryReplace` | `PUT /fhir/R4/Binary/{id}` | ✅ supported | ❌ disabled | Covered by the binary scenario. |
| `SearchPatient` | `GET /fhir/R4/Patient` | ✅ supported | ✅ |  |
| `CreatePatient` | `POST /fhir/R4/Patient` | ✅ supported | ✅ |  |
| `ReadPatient` | `GET /fhir/R4/Patient/{id}` | ✅ supported | ✅ |  |
| `UpdatePatient` | `PUT /fhir/R4/Patient/{id}` | ✅ supported | ❌ disabled | The body must carry the id from the path; covered by the random differential walks. |
| `DeletePatient` | `DELETE /fhir/R4/Patient/{id}` | ✅ supported | ✅ |  |
| `ReadPatientHistory` | `GET /fhir/R4/Patient/{id}/_history` | ✅ supported | ✅ |  |
| `PatientEverything` | `GET /fhir/R4/Patient/{id}/$everything` | ✅ supported | ❌ disabled | Covered by the resource variety scenario. |
| `FhirSearch` | `GET /fhir/R4/{resourceType}` | ✅ supported | ❌ disabled | Every resource type; covered by the search scenarios and random walks. |
| `FhirConditionalUpdate` | `PUT /fhir/R4/{resourceType}` | ✅ supported | ❌ disabled | Covered by the conditional scenario. |
| `FhirCreate` | `POST /fhir/R4/{resourceType}` | ✅ supported | ❌ disabled | Every resource type; covered by the scenarios and random walks. |
| `FhirConditionalDelete` | `DELETE /fhir/R4/{resourceType}` | ✅ supported | ❌ disabled | Covered by the conditional scenario. |
| `FhirConditionalPatch` | `PATCH /fhir/R4/{resourceType}` | ✅ supported | ❌ disabled | Covered by the conditional scenario. |
| `FhirSearchPost` | `POST /fhir/R4/{resourceType}/_search` | ✅ supported | ❌ disabled | Covered by the search scenarios. |
| `FhirValidate` | `POST /fhir/R4/{resourceType}/$validate` | ✅ supported | ❌ disabled | Covered by the server scenarios. |
| `FhirRead` | `GET /fhir/R4/{resourceType}/{id}` | ✅ supported | ❌ disabled | Every resource type; covered by the scenarios and random walks. |
| `FhirUpdate` | `PUT /fhir/R4/{resourceType}/{id}` | ✅ supported | ❌ disabled | Covered by the scenarios and random walks. |
| `FhirDelete` | `DELETE /fhir/R4/{resourceType}/{id}` | ✅ supported | ❌ disabled | Covered by the scenarios and random walks. |
| `FhirPatch` | `PATCH /fhir/R4/{resourceType}/{id}` | ✅ supported | ❌ disabled | Covered by the patch scenario and random walks. |
| `FhirHistory` | `GET /fhir/R4/{resourceType}/{id}/_history` | ✅ supported | ❌ disabled | Covered by the scenarios and random walks. |
| `FhirVersionRead` | `GET /fhir/R4/{resourceType}/{id}/_history/{versionId}` | ✅ supported | ❌ disabled | Covered by the CRUD scenarios. |
| `FhirExpunge` | `POST /fhir/R4/{resourceType}/{id}/$expunge` | ✅ supported | ❌ disabled | Super admin only; erases history. |
