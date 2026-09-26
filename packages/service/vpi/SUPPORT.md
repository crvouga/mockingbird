# VPI compounding pharmacy API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **18**
- supported by the mock: **18**
- parity enabled: **18**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `Authenticate` | `POST /accounts/authenticate` | ✅ supported | ✅ |  |
| `GetAllFamiliesAndCategories` | `GET /products/getAllFamiliesAndCategories` | ✅ supported | ✅ |  |
| `GetProductsByCategory` | `POST /products/getProductsByCategory` | ✅ supported | ✅ |  |
| `GetProductDetailsByProductId` | `GET /products/getProductDetailsByProductId/{productId}` | ✅ supported | ✅ |  |
| `GetProductDiscountByProductIds` | `POST /products/getProductDiscountByProductIds` | ✅ supported | ✅ |  |
| `CalculateDaySupply` | `POST /products/calculateDaySupply` | ✅ supported | ✅ |  |
| `GetShippingStates` | `GET /admin/rxOrdering/getShippingStates` | ✅ supported | ✅ |  |
| `GetShippingRate` | `POST /portal/getShippingRate` | ✅ supported | ✅ |  |
| `CheckProviderSignatureNeededDuplicate` | `POST /clinic/rxOrdering/checkProviderSignatureNeededDuplicate` | ✅ supported | ✅ |  |
| `SaveNewPrescription` | `POST /clinic/rxOrdering/saveNewPrescription` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPatientByPatientId` | `POST /patients/getPatientByPatientId` | ✅ supported | ✅ |  |
| `GetPatientAddressesByPatientId` | `POST /patients/getPatientAddressesByPatientId` | ✅ supported | ✅ |  |
| `GetPatientsInClinic` | `POST /patients/getPatientsInClinic` | ✅ supported | ✅ |  |
| `GetAllProvidersByClinicLocationId` | `POST /staffs/getAllProvidersByClinicLocationId` | ✅ supported | ✅ |  |
| `GetClinicLocationByClinicLocationId` | `POST /clinicLocations/getClinicLocationByClinicLocationId` | ✅ supported | ✅ |  |
| `GetIncompleteSavedPrescriptionsInClinicLocation` | `POST /clinic/rxOrdering/getIncompleteSavedPrescriptionsInClinicLocation` | ✅ supported | ✅ |  |
| `GetSubmittedPrescriptionsInClinicLocation` | `POST /clinic/rxOrdering/getSubmittedPrescriptionsInClinicLocation` | ✅ supported | ✅ |  |
| `GetArchivedPrescriptionsInClinic` | `POST /clinic/rxOrdering/getArchivedPrescriptionsInClinic` | ✅ supported | ✅ |  |
