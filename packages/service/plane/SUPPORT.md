# Plane REST API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **20**
- supported by the emulator: **20**
- parity enabled: **20**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListAttachments` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/attachments/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateAttachment` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/attachments/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ConfirmAttachment` | `PATCH /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/attachments/{asset_id}/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UploadAttachment` | `POST /__admin/blobs/plane/uploads` | ✅ supported | ⚠️ unsafe (opt-in) |  |
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
| `ListCycles` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/cycles/` | ✅ supported | ✅ |  |
| `CreateCycle` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/cycles/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListCycleWorkItems` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/cycles/{cycle_id}/cycle-issues/` | ✅ supported | ✅ |  |
| `AddCycleWorkItems` | `POST /api/v1/workspaces/{slug}/projects/{project_id}/cycles/{cycle_id}/cycle-issues/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListWorkItemTypes` | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-item-types/` | ✅ supported | ✅ |  |
