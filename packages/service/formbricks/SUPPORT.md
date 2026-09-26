# Formbricks client + management API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the mock: **8**
- parity enabled: **8**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GetEnvironmentState` | `GET /api/v1/client/{workspaceId}/environment` | ✅ supported | ✅ |  |
| `CreateClientResponse` | `POST /api/v2/client/{workspaceId}/responses` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListResponses` | `GET /api/v1/management/responses` | ✅ supported | ✅ |  |
| `GetResponse` | `GET /api/v1/management/responses/{responseId}` | ✅ supported | ✅ |  |
| `ListSurveys` | `GET /api/v1/management/surveys` | ✅ supported | ✅ |  |
| `CreateSurvey` | `POST /api/v1/management/surveys` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSurvey` | `GET /api/v1/management/surveys/{surveyId}` | ✅ supported | ✅ |  |
| `GetWidgetScript` | `GET /js/formbricks.umd.cjs` | ✅ supported | ✅ |  |
