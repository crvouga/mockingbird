# Optimal DX partner API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **15**
- supported by the mock: **15**
- parity enabled: **15**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListPartnerLabs` | `GET /v1/partner/labs` | ✅ supported | ✅ |  |
| `ListElements` | `GET /v1/elements/{labId}` | ✅ supported | ✅ |  |
| `CreatePatient` | `POST /v1/practice/{practiceId}/patient` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UpdatePatient` | `PUT /v1/practice/{practiceId}/patient/{patientId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeletePatient` | `DELETE /v1/practice/{practiceId}/patient/{patientId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `LinkPartnerUser` | `POST /v1/practice/{practiceId}/patient/{patientId}/partner/{localUserId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListPatients` | `GET /v1/practice/{practiceId}/patients` | ✅ supported | ✅ |  |
| `CreateTestResults` | `POST /v1/practice/{practiceId}/patient/{patientId}/testresults` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreatePatientTest` | `POST /v1/practice/{practiceId}/patient/{patientId}/test` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UpdatePatientTest` | `PUT /v1/practice/{practiceId}/patient/{patientId}/test/{patientTestId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListPatientTests` | `GET /v1/practice/{practiceId}/patient/{patientId}/tests` | ✅ supported | ✅ |  |
| `GenerateFunctionalHealthReport` | `POST /v1/reports/FunctionalHealthReport` | ✅ supported | ✅ |  |
| `ListWebhooks` | `GET /v1/webhooks` | ✅ supported | ✅ |  |
| `RegisterWebhook` | `POST /v1/webhook` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UpdateWebhook` | `PUT /v1/webhook/{partnerWebhookId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
