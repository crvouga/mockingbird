# PostHog feature flags, capture and management API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **16**
- supported by the mock: **16**
- parity enabled: **16**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `EvaluateFlags` | `POST /flags` | ✅ supported | ✅ |  |
| `Decide` | `POST /decide` | ✅ supported | ✅ |  |
| `GetRemoteConfig` | `GET /array/{token}/config` | ✅ supported | ✅ |  |
| `GetRemoteConfigScript` | `GET /array/{token}/config.js` | ✅ supported | ✅ |  |
| `CaptureBatch` | `POST /batch` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CaptureEvent` | `POST /e` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CaptureEventV0` | `POST /i/v0/e` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CaptureRecording` | `POST /s` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRecorderScript` | `GET /static/recorder.js` | ✅ supported | ✅ |  |
| `GetVersionedRecorderScript` | `GET /static/{version}/recorder.js` | ✅ supported | ✅ |  |
| `ListSurveys` | `GET /api/surveys` | ✅ supported | ✅ |  |
| `ListWebExperiments` | `GET /api/web_experiments` | ✅ supported | ✅ |  |
| `ListFeatureFlags` | `GET /api/projects/{projectId}/feature_flags` | ✅ supported | ✅ |  |
| `CreateFeatureFlag` | `POST /api/projects/{projectId}/feature_flags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UpdateFeatureFlag` | `PATCH /api/projects/{projectId}/feature_flags/{flagId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RunQuery` | `POST /api/projects/{projectId}/query` | ✅ supported | ✅ |  |
