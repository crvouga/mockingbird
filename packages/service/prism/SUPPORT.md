# Prism Labs body-scan API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **11**
- supported by the mock: **11**
- parity enabled: **9**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `UpsertUser` | `POST /users` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateScan` | `POST /scans` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetScan` | `GET /scans/{scanId}` | ✅ supported | ✅ |  |
| `CreateUploadUrl` | `POST /scans/{scanId}/upload-url` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetScanAssets` | `GET /scans/{scanId}/scan-assets` | ✅ supported | ✅ |  |
| `GetBodyfat` | `GET /scans/{scanId}/bodyfat` | ✅ supported | ✅ |  |
| `GetMeasurements` | `GET /scans/{scanId}/measurements` | ✅ supported | ✅ |  |
| `GetHealthReport` | `GET /scans/{scanId}/health-report` | ✅ supported | ✅ |  |
| `GetAssetUrls` | `GET /scans/{scanId}/asset-urls` | ✅ supported | ✅ |  |
| `UploadCapture` | `PUT /uploads/{scanId}` | ✅ supported | ❌ disabled | Binary video upload through a presigned URL; covered by acceptance tests. |
| `GetAsset` | `GET /assets/{scanId}/{file}` | ✅ supported | ❌ disabled | Binary asset bytes; covered by acceptance tests. |
