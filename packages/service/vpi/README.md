# @crvouga/mockingbird-service-vpi

> [!WARNING]
> **Our app's `VPI_API_URL` defaults to PRODUCTION** (`https://api.vpicompounding.net`, see
> `apps/backend/src/modules/erx/clients/vpi-api.client.ts`). An unset variable sends real
> prescriptions to the real pharmacy. The stack **must** set `VPI_API_URL` to this mock (e.g.
> `http://127.0.0.1:8802`) whenever the VPI rail is reachable.

Stateful mock of the **VPI** compounding-pharmacy clinic API that our backend drives as a
draft-only eRx rail: JWT authentication, the product taxonomy/details/discounts, day supply,
shipping states and rates, the clinic location, providers, the patient roster and details,
the provider-signature duplicate check, `saveNewPrescription`, and the three paged prescription
status lists our poller reads. Prescriptions move only when a test says so (an admin
transition). VPI sends no webhooks: our backend polls page 1 (limit 5) of each list.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/vpi/SUPPORT.md)
- The vendor publishes no spec: the contract (`openapi.yaml`) is hand-derived from our client's
  zod schemas (`vpi-api.contracts.ts` plus the client-local schemas in `vpi-api.client.ts`).
  The acceptance tests parse every mock response with a verbatim port of those schemas.

## Install

```bash
npm install -D @crvouga/mockingbird-service-vpi
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-vpi serve`, `createServer` from `./server` (Node), or `createRuntime` with any
Fetch server.

## Usage

Point the app at the mock and give it any credentials (any pair logs in unless `accounts` is set):

```bash
npx mockingbird-vpi serve --port 8802
# app env:
#   VPI_API_URL=http://127.0.0.1:8802           (REQUIRED: the default is production)
#   VPI_API_EMAIL=clinic@example.com  VPI_API_PASSWORD=anything
#   VPI_CLINIC_LOCATION_ID=65a1c0de00000000000000d1
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-vpi"

const vpi = createRuntime()
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  vpi.fetch(
    new Request(`http://vpi.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )

const { jwtToken } = (await (
  await post("/accounts/authenticate", { email: "clinic@example.com", password: "x" })
).json()) as { jwtToken: string }
// …the app saves a draft with POST /clinic/rxOrdering/saveNewPrescription (Bearer jwtToken)…

// Move it the way the pharmacy would; our poller maps each status.
await post("/__admin/prescriptions/66b200000000000000000001/transition", {
  to: "Order Completed",
  trackingNumber: "1Z999",
})
```

### Seed data

Every namespace starts with: user `65a1c0de00000000000000a1` (every login resolves to it unless
`accounts` is set), clinic `65a1c0de00000000000000c1`, clinic location
`65a1c0de00000000000000d1` ("Geviti Main"), providers Grace Hopper (NPI `1234567893`, id
`65a1c0de00000000000000e1`) and Alan Turing (NPI `1987654320`), patient Ada Lovelace
(`65a1c0de00000000000000f1`, DOB 1985-02-14, 1 Main St, Phoenix AZ 85004), and four products:
Testosterone Cypionate (`64f1c2a9e4b0a1b2c3d4e5f6` / `2185_INJ`, sterile, 10% clinic discount),
Semaglutide / B6 Troche (`3097_POW`, cold-shipped), Enclomiphene (`4410_CAP`, no compounding
reason needed) and Nandrolone (`5120_INJ`, **controlled**: refused by `saveNewPrescription`).
Replace any of it with `createRuntime({ data: { products, providers, clinicLocations, patients } })`.

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /accounts/authenticate` | `{email, password, isPatientLogin: false}` → `{id, jwtToken, refreshToken}`. The JWT payload carries `sub` (user id), `email`, `iat` and `exp` = mock-clock now + `tokenTtlSeconds` (default 3600). Our client caches it until `exp` − 30 s and re-authenticates once on a 401. `isPatientLogin: true` is refused. |
| every other route | Requires `Authorization: Bearer <jwtToken>`: missing or tampered → 401 `Unauthorized`; expired on the mock clock → 401 `jwt expired`. |
| `GET /products/getAllFamiliesAndCategories` | `[{family, categories: [subCategory1…]}]`. |
| `POST /products/getProductsByCategory` | `{category, subCategory1}` → `[{subCategory2_item, commonNames: [{commonName, products: [...]}]}]`. |
| `GET /products/getProductDetailsByProductId/{id}` | By Mongo id: full details incl. `sigOptions`, `reasonForCompoundedMedication`, `patientPayAmount`, `ndc` (a number). 404 if unknown. |
| `POST /products/getProductDiscountByProductIds` | `{clinicId, productIds}` → `[{id, productId, discountedPrice, unitPrice, discountedPercentage, controlledSubstance}]` for known products. |
| `POST /products/calculateDaySupply` | `{productId, quantity, sig}` → `{daySupply, daySupplyReason}` (per-each products: 1 per day; otherwise 30). |
| `GET /admin/rxOrdering/getShippingStates` | `{data: [{states: [{name: "Arizona", booleanCheck, nonSterile, sterile}]}]}` (full names; no sterile shipping to Alabama or DC). |
| `POST /portal/getShippingRate` | `{clinicId, clinicLocationId, patientId, productIds, shippingState: "AZ", isRushOrder}` → `{shippingMethod, rushOrderCost, rushOrderMethod, isSignatureRequired}`; 400 for a state VPI does not ship (sterile) to. |
| `POST /clinic/rxOrdering/checkProviderSignatureNeededDuplicate` | `isDuplicate` is true when an active (not archived) prescription exists for the same patient and product; `isProviderSignatureNeeded` from settings (default true). |
| `POST /clinic/rxOrdering/saveNewPrescription` | Validates the whole payload against the contract (the shipping state must be the **canonical full name**, `controlledSubstance` must be `"0"`, …) → 400 `{message, errors: [{path, message}]}`; unknown clinic/location/provider/patient/product → 404; a controlled or code-mismatched product → 400. Success: a draft `Provider Signature Needed` in the incomplete list → `{message, prescriptionId, isRefillRequest: false, refillFromPrescriptionId: null}`. |
| `POST /patients/getPatientByPatientId`, `…/getPatientAddressesByPatientId` | `{patientId, userId}` → the patient (`dateOfBirth`, `phoneNumber`, `cellPhone`), or `{addresses: [...]}`. |
| `POST /patients/getPatientsInClinic` | `{clinicId, userId, limit, currentPage}` → `{pagination: {hasNextPage, currentPage, limit, totalCount}, patients}`. |
| `POST /staffs/getAllProvidersByClinicLocationId` | `{clinicLocationId, clinicId}` → providers with `npi`. |
| `POST /clinicLocations/getClinicLocationByClinicLocationId` | `{clinicLocationId}` → `{id, clinicId, locationName, …}`. |
| `POST /clinic/rxOrdering/getIncompleteSavedPrescriptionsInClinicLocation`, `…/getSubmittedPrescriptionsInClinicLocation`, `…/getArchivedPrescriptionsInClinic` | `{clinicLocationId, userId, limit, currentPage}` → one page, newest first, of `{prescriptionId, prescriptionStatus, trackingNumber, patientId, createdAt}`. Envelope per `statusEnvelope` (default `vendor`: submitted `{message: {prescriptions}}`, archived `{message: [...]}` with rows keyed `id`, incomplete a bare array). |

### Lifecycle and status lists

| Transition `to` | List | Our consumer's mapping |
| --- | --- | --- |
| `Provider Signature Needed` (draft), `Signature Needed`, `New Formula Pending` | incomplete | processing |
| `Received`, `Order Received` | submitted | submitted |
| `In Process`, `Order In Process`, `Prescriptions In Process`, `On Hold`, `Order On Hold` | submitted | processing |
| `Completed`, `Order Complete`, `Order Completed` (adds a `1Z…` tracking number when none is given) | submitted | shipped |
| `Cancelled`, `Order Cancelled` | archived | cancelled |
| `Archived`, or any other string (used verbatim) | archived / submitted | unmapped (no refresh) |

Our consumer has **no delivered status** for VPI and the draft rail starts at `processing`, so a
payment on this rail moves processing → shipped (or cancelled).

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/prescriptions/:id/transition` | `{to, trackingNumber?, list?: "incomplete" \| "submitted" \| "archived"}`. |
| `GET /__admin/prescriptions` | The namespace's prescriptions (ids and status only). |
| `POST /__admin/patients` | Seed a clinic patient `{firstName, lastName, dateOfBirth, email?, phoneNumber?, cellPhone?, id?, clinicId?, addresses?: [{addressLine1, addressLine2?, city, state, zipcode}]}` (VPI patient creation is not part of our client). `GET` lists them. |
| `GET /__admin/catalog` | Products, providers and clinic locations. |
| `PUT /__admin/settings` | `{tokenTtlSeconds?, accounts?: [{email, password, id}], statusEnvelope?, isProviderSignatureNeeded?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`token_expired` (401 on authorized calls; with `count: 1` our client re-authenticates exactly
once and the retry succeeds), `unauthorized_twice` (the retry fails too), `auth_rejected`,
`server_error`, `duplicate_prescription`, `save_ambiguous_409` (saves the draft, then 409: our
classifier says needs_review), `save_rate_limited` (429, not saved: needs_review), `save_400`
(retry via the browser agent), `response_drift` (taxonomy and product-details fields change type:
our zod parse fails closed).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `VPI_API_URL`, or by login email:
`PUT /__admin/credentials {"credentials": {"<VPI_API_EMAIL>": "<namespace>"}}` (the JWT carries
the email). Authentication itself lands in the default namespace (or the `/ns/` one); tokens
verify in every namespace.

### Deliberately not modelled

- Webhooks: VPI has none; our backend polls.
- Patient creation, clinic default-card billing (`encryptedBillingInfo`) and provider signing:
  our client has not captured those contracts; seed patients through the admin API.
- The refresh-token exchange (our client re-authenticates with email/password instead).
- Real pricing, tax and shipping-rate tables: rates are fixed per cold/sterile/rush.
- The live catalog: the seed is synthesised in our client's field names (no sandbox recording).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `VpiAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(id, {to, trackingNumber?, list?})`, `addPatient(input)`, `prescriptions()`. Options: `sqlite`, `now`, `namespace`, `seed`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, journal). Options: `data`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `VPI_PRESETS` | object | Every named fault preset. |
| `VPI_NAMESPACE` | string | The service name, `"vpi"`. |
| `tokenCredential` | function | The login email a bearer JWT carries (how credentials map to namespaces). |
| `issueJwt` | function | Mint a JWT the mock accepts, from `{sub, email, iat, exp}`. |
| `DEFAULT_USER_ID`, `DEFAULT_CLINIC_ID`, `DEFAULT_CLINIC_LOCATION_ID`, `DEFAULT_PROVIDER_ID`, `DEFAULT_PATIENT_ID` | strings | The seeded ids. |
| `DEFAULT_PRODUCTS`, `DEFAULT_PROVIDERS`, `DEFAULT_PATIENTS`, `DEFAULT_CLINIC_LOCATION`, `SHIPPING_STATES` | values | The seed data. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--token-ttl`); port 8802. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
