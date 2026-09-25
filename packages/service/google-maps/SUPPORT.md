# Google Places, Geocoding and Maps JavaScript API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the mock: **6**
- parity enabled: **5**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `PlaceAutocomplete` | `GET /maps/api/place/autocomplete/json` | ✅ supported | ✅ |  |
| `PlaceDetails` | `GET /maps/api/place/details/json` | ✅ supported | ✅ |  |
| `Geocode` | `GET /maps/api/geocode/json` | ✅ supported | ✅ |  |
| `FindPlaceFromText` | `GET /maps/api/place/findplacefromtext/json` | ✅ supported | ✅ |  |
| `MapsJavaScriptApi` | `GET /maps/api/js` | ✅ supported | ❌ disabled | A JavaScript program, not data: it is exercised by evaluating it in a fake window and driving our web client through it (google-maps.acceptance.test.ts). |
| `ValidateAddress` | `POST /v1:validateAddress` | ✅ supported | ✅ |  |
