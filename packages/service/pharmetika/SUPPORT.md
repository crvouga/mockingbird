# Pharmetika provider portal API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the mock: **9**
- parity enabled: **9**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListClinics` | `GET /api/v5/provider_portal/clinic/clinic_list` | ✅ supported | ✅ |  |
| `ListPatients` | `GET /api/v5/provider_portal/provider/patient_list` | ✅ supported | ✅ |  |
| `CreatePatient` | `POST /api/v5/provider_portal/patient/create_new` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ValidateMedicationOrder` | `PUT /api/v5/provider_portal/medication_order/id/{orderId}/validate` | ✅ supported | ✅ |  |
| `GetMedicationOrder` | `GET /api/v5/provider_portal/medication_order/id/{orderId}` | ✅ supported | ✅ |  |
| `PrepareMedicationOrder` | `PUT /api/v5/provider_portal/medication_order/id/{orderId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SubmitMedicationOrder` | `PUT /api/v5/provider_portal/medication_order/id/{orderId}/submit` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CancelMedicationOrder` | `PUT /api/v7/provider_portal/medication_order/entry/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListMedicationTemplates` | `GET /api/pharmetika/provider_access/profile/medication_templates` | ✅ supported | ✅ |  |
