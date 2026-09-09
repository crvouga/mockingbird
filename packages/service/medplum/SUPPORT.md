# Medplum API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the mock: **8**
- parity enabled: **5**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GetHealthcheck` | `GET /healthcheck` | ✅ supported | ❌ disabled | Infrastructure endpoint used for boot polling; excluded from differential walks. |
| `PostAuthLogin` | `POST /auth/login` | ✅ supported | ❌ disabled | Seeded-admin credential flow; exercised by lifecycle helpers, not by differential walks. |
| `PostOauth2Token` | `POST /oauth2/token` | ✅ supported | ❌ disabled | One-time token exchange; tokens are minted per login, so walks cannot replay them. |
| `SearchPatient` | `GET /fhir/R4/Patient` | ✅ supported | ✅ |  |
| `CreatePatient` | `POST /fhir/R4/Patient` | ✅ supported | ✅ |  |
| `ReadPatient` | `GET /fhir/R4/Patient/{id}` | ✅ supported | ✅ |  |
| `UpdatePatient` | `PUT /fhir/R4/Patient/{id}` | ✅ supported | ✅ |  |
| `DeletePatient` | `DELETE /fhir/R4/Patient/{id}` | ✅ supported | ✅ |  |
