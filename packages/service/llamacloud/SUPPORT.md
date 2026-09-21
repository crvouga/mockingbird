# LlamaCloud platform API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the mock: **10**
- parity enabled: **10**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListProjects` | `GET /api/v1/projects` | ✅ supported | ✅ |  |
| `GetProject` | `GET /api/v1/projects/{project_id}` | ✅ supported | ✅ |  |
| `SearchPipelines` | `GET /api/v1/pipelines` | ✅ supported | ✅ |  |
| `GetPipeline` | `GET /api/v1/pipelines/{pipeline_id}` | ✅ supported | ✅ |  |
| `RunSearch` | `POST /api/v1/pipelines/{pipeline_id}/retrieve` | ✅ supported | ✅ |  |
| `ListPipelineDocuments` | `GET /api/v1/pipelines/{pipeline_id}/documents` | ✅ supported | ✅ |  |
| `UpsertBatchPipelineDocuments` | `PUT /api/v1/pipelines/{pipeline_id}/documents` | ✅ supported | ✅ |  |
| `CreateBatchPipelineDocuments` | `POST /api/v1/pipelines/{pipeline_id}/documents` | ✅ supported | ✅ |  |
| `GetPipelineDocument` | `GET /api/v1/pipelines/{pipeline_id}/documents/{document_id}` | ✅ supported | ✅ |  |
| `DeletePipelineDocument` | `DELETE /api/v1/pipelines/{pipeline_id}/documents/{document_id}` | ✅ supported | ✅ |  |
