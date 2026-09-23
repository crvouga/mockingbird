# Plane REST API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **11**
- supported by the mock: **11**
- parity enabled: **11**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListWorkItems` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/` | ✅ supported | ✅ |  |
| `CreateWorkItem` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/work-items/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetWorkItem` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/` | ✅ supported | ✅ |  |
| `UpdateWorkItem` | `PATCH /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListComments` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/comments/` | ✅ supported | ✅ |  |
| `CreateComment` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/comments/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListLinks` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/links/` | ✅ supported | ✅ |  |
| `CreateLink` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/links/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListStates` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/states/` | ✅ supported | ✅ |  |
| `ListLabels` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/labels/` | ✅ supported | ✅ |  |
| `CreateLabel` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/labels/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
