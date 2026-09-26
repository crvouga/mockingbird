# @crvouga/mockingbird-service-google-maps

Mock of the **Google Maps Platform** surface our member app uses for addresses: Places
Autocomplete, Place Details and Find Place From Text (the JSON web services), the Geocoding API,
a **Maps JavaScript API shim** (`/maps/api/js?libraries=places`) exposing
`google.maps.places.*` and `google.maps.Geocoder` over the same data, and the **Address
Validation API** (`POST /v1:validateAddress`, with USPS CASS/DPV data) for server-side ship-to
checks. Answers come from a corpus
matching our QA fixtures, so the address step that waits 5 s for Google predictions (and then
falls back to manual entry) resolves instantly and deterministically.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/google-maps/SUPPORT.md)
- Google publishes no OpenAPI document for these endpoints: `openapi.yaml` is hand-authored
  from Google's documented shapes and the fields our consumer reads. Address Validation follows
  the [REST reference](https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress)
  and [`ValidationResult`](https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/ValidationResult).

## Install

```bash
npm install -D @crvouga/mockingbird-service-google-maps
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-google-maps serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

The app hardcodes `https://maps.googleapis.com` (seam **G-Y1**: a base-URL env for
`M/lib/ui/address-autocomplete/address-autocomplete-native-rest.tsx`,
`M/features/bloodwork/shared/lab-finder/use-geocoded-address.ts` and
`M/lib/ui/google-maps/load-google-maps-script.ts`). Until it lands, rewrite that host to the mock
in the stack's web dist (`stack-web-dist.ts`), as for PostHog. `PLACES_KEY` can be any non-empty
string unless you restrict keys.

```bash
npx mockingbird-google-maps serve --port 8814 --api-key "$PLACES_KEY"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-google-maps"

const maps = createRuntime()
const get = async (path: string) =>
  (await maps.fetch(new Request(`http://maps.test${path}`))).json()

const { predictions } = await get(
  "/maps/api/place/autocomplete/json?input=1625%20N%20Central&types=address&components=country:us&key=k",
)
const details = await get(
  `/maps/api/place/details/json?place_id=${predictions[0].place_id}&fields=address_component&key=k`,
)
// details.result.address_components → 1625 / N Central Ave / Phoenix / AZ / 85004

// Make the next two autocomplete calls fail, as QA's manual-entry fallback expects.
maps.applyPreset("autocomplete_over_query_limit", "default", { count: 2 })
```

### Address Validation

Google serves it from a different host, `https://addressvalidation.googleapis.com`; the paths do
not collide, so one mock serves both. Point the server-side client's Address Validation base URL
at the mock (or at `<mock>/ns/<namespace>`), with the key as `?key=` (or `X-Goog-Api-Key`).

```ts
import { createRuntime } from "@crvouga/mockingbird-service-google-maps"

const maps = createRuntime()
const response = await maps.fetch(
  new Request("http://maps.test/v1:validateAddress?key=k", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: {
        regionCode: "US",
        addressLines: ["1625 N Central Ave"],
        locality: "Phoenix",
        administrativeArea: "AZ",
        postalCode: "85004",
      },
      enableUspsCass: true,
    }),
  }),
)
const { result } = await response.json()
// result.verdict → PREMISE / addressComplete / ACCEPT; result.uspsData.dpvConfirmation → "Y"

// Force the USPS "not deliverable" answer on the next call.
maps.applyPreset("address_validation_dpv_n", "default", { count: 1 })
```

On web, load `<mock>/maps/api/js?key=…&libraries=places` exactly as the app loads Google's
script; the shim calls back into the mock's REST endpoints on the same origin and namespace.

### Routes

Every web-service answer is **HTTP 200** with Google's `status` (`OK`, `ZERO_RESULTS`,
`INVALID_REQUEST`, `NOT_FOUND`, `REQUEST_DENIED`, `OVER_QUERY_LIMIT`, `UNKNOWN_ERROR`) and, for
errors, Google's `error_message`. Responses carry `access-control-allow-origin: *` so the shim
works from a browser.

| Route | Behaviour |
| --- | --- |
| `GET /maps/api/place/autocomplete/json` | `input` (required, else `INVALID_REQUEST`), `types`, `components=country:us`, `sessiontoken`. `predictions[]` with `description`, `place_id`, `reference`, `structured_formatting{main_text, main_text_matched_substrings, secondary_text}`, `terms`, `types`, `matched_substrings`; at most 5. Matches corpus rows by token prefix (street, city, state, ZIP); `"<number> <street> <corpus city>[ <ST>][ <ZIP>]"` is **synthesized** in that row's city/state/ZIP (QA's fuzzed search). Nothing → `ZERO_RESULTS`; a non-US `components` → `ZERO_RESULTS`. |
| `GET /maps/api/place/details/json` | `place_id` (required), `fields` (honoured: `address_component` returns only `address_components`; unknown field → `INVALID_REQUEST`), `sessiontoken`. `result` with `address_components` (`street_number`, `route`, `locality`, `administrative_area_level_2`, `administrative_area_level_1` long/short, `country`, `postal_code`), `formatted_address`, `geometry{location, viewport}`, `place_id`, `types`, `name`, `url`, `vicinity`. Unknown id → `NOT_FOUND`. |
| `GET /maps/api/geocode/json` | `address`, `place_id` or `components=postal_code:…` (none → `INVALID_REQUEST`). `results[0]` with `address_components`, `formatted_address`, `geometry{location, location_type, viewport}`, `place_id`, `types`. A full address (`"line1, city, ST zip"`) resolves to its row or a synthesized address; a bare ZIP or `"City, ST"` to the ZIP centroid; a street without a locatable city is `ZERO_RESULTS`. |
| `GET /maps/api/place/findplacefromtext/json` | `input` + `inputtype=textquery` (else `INVALID_REQUEST`), `fields` (default: `place_id` only, as Google). Geocoding first, then the looser autocomplete match, so it finds what our geocode fallback needs. |
| `POST /v1:validateAddress` | Address Validation (see below). A Google Cloud API: errors are HTTP 4xx/5xx with `{"error": {code, message, status}}`, not a 200 with `status`. |
| `GET /maps/api/js` | The shim (`text/javascript`): `google.maps.places.AutocompleteService#getPlacePredictions`, `PlacesService#getDetails` / `#findPlaceFromQuery`, `AutocompleteSessionToken`, `PlacesServiceStatus`, `google.maps.Geocoder#geocode`, `GeocoderStatus`, `LatLng` (`lat()`/`lng()`), `LatLngBounds`, `importLibrary`. Callbacks and promises (rejecting with `MapsRequestError` on errors when no callback is given). Calls `window[callback]` for `&callback=`, and `window.gm_authFailure()` when the key is refused. |

### Address Validation verdicts

Answers are proto3 JSON, as Google sends them: `false` booleans and empty lists are omitted
(no `unconfirmedComponentTypes: []`). `result` carries `verdict` (`inputGranularity`,
`validationGranularity`, `geocodeGranularity`, `addressComplete`, `has*Components`,
`possibleNextAction`), `address` (`formattedAddress`, `postalAddress`, `addressComponents` with
`confirmationLevel` / `inferred` / `replaced`, `missingComponentTypes`,
`unconfirmedComponentTypes`), `geocode` (`location`, `placeId`, `placeTypes`) and, for US
addresses, `uspsData` (`standardizedAddress`, `dpvConfirmation`, `dpvFootnote`,
`postOfficeCity`/`State`, `errorMessage`, `cassProcessed` when `enableUspsCass`). Every answer
has a `responseId`. Send a componentized address (line 1 + optional unit line 2, `locality`,
`administrativeArea`, `postalCode`) or everything in `addressLines`.

| Input | Verdict |
| --- | --- |
| A corpus row (`1625 N Central Ave`, Phoenix AZ 85004); spelled-out words (`North`, `Avenue`) match | `PREMISE`, complete, `ACCEPT`, DPV `Y`; `postalAddress` echoes the corpus spelling with a deterministic ZIP+4 (`85004-NNNN`) |
| `<number> <street>` in a corpus city | Synthesized, as for Autocomplete: `PREMISE`, `ACCEPT`, DPV `Y`, the street USPS-abbreviated (`Maple Street` → `Maple St`) |
| A unit on a single-delivery-point row (`… Building A`, `Apt 4`) | `PREMISE`, complete, `CONFIRM`, `subpremise` unconfirmed, DPV `Y` |
| No house number (`N Central Ave`) in a corpus city | `ROUTE`, `FIX`, `missingComponentTypes: ["street_number"]`, no DPV code |
| A city/ZIP the corpus does not hold | `OTHER`, `FIX`, the unplaceable components unconfirmed, DPV `N` |
| A ZIP that is wrong for the city (or a city that is wrong for the ZIP) | Replaced: `hasReplacedComponents`, `CONFIRM`, the corrected value in `postalAddress` |
| A row with `validation.multiUnit` | No unit: `CONFIRM_ADD_SUBPREMISES`, `missingComponentTypes: ["subpremise"]`, DPV `D`. A unit in `validation.units` (or any, when `units` is absent): `SUB_PREMISE`, `ACCEPT`, `Y`. Another unit: `PREMISE`, `CONFIRM`, `subpremise` unconfirmed, DPV `S` |
| A row with `validation.uspsErrorMessage` | `uspsData: {errorMessage}` and no DPV code |
| No `address`, empty `addressLines`, an unknown field, non-JSON, over 280 characters, or `enableUspsCass` outside `US`/`PR` | 400 `INVALID_ARGUMENT` |
| No key | 403 `PERMISSION_DENIED` "The request is missing a valid API key." |
| A key outside `settings.keys` | 400 `INVALID_ARGUMENT` "API key not valid. Please pass a valid API key." (`reason: API_KEY_INVALID`), as Google answers an unknown key; `address_validation_denied` gives the 403 of a key without the API enabled |

### Corpus

59 addresses: every row of QA's `ROUTING_ZIP_CORPUS` (`packages/qa/src/world/gen/addresses.ts`,
≥1 real ZIP per state + DC, ids kept), which includes the **Phoenix AZ demo member**
(`ADDRESS_AT_HOME_PHLEBOTOMY`: 1625 N Central Ave, Phoenix, AZ 85004) and the other
`packages/app/src/test-addresses` members, plus `ADDRESS_AT_HOME_PHLEBOTOMY_2` (501 N 5th St).
Each has its real county and the city's coordinates. Place ids are stable (`ChIJ…` for rows;
synthesized addresses get an `Ei…` id carrying the address, as Google's own address ids do, so
Details needs no stored state). `GET /health` reports the corpus.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/corpus` | The namespace's addresses (custom first) and the custom count. |
| `PUT /__admin/corpus` | `{addresses: [{line1, city, state, zip, id?, county?, lat?, lng?, validation?}]}` replaces the namespace's custom addresses (on top of the built-in corpus). `validation` pins Address Validation for that row: `{granularity?, addressComplete?, possibleNextAction?, dpvConfirmation?: "Y"\|"N"\|"S"\|"D", unconfirmedComponentTypes?, uspsErrorMessage?, multiUnit?, units?}`. |
| `DELETE /__admin/corpus` | Drop the custom addresses. |
| `GET/PUT /__admin/settings` | `{keys?: string[], publicUrl?: string \| null}`. `keys` restricts accepted API keys (others get `REQUEST_DENIED` "The provided API key is invalid."; a missing key always does). `publicUrl` is the origin the JS shim calls back to when it differs from the request's (a rewriting proxy). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`over_query_limit`, `request_denied`, `unknown_error`, `zero_results` (every web service, HTTP 200
with that status), `geocode_zero_results` (exercises our Find Place fallback),
`autocomplete_over_query_limit` (two of these flip our sheet to manual entry), `server_error`
(HTTP 500), `slow` (6 s, past QA's 5 s wait), `script_unavailable` (the JS loader answers 503, so
the script's `onerror` fires). For Address Validation only: `address_validation_denied` (403
`PERMISSION_DENIED`, a key without the API enabled), `address_validation_unavailable` (503
`UNAVAILABLE`), `address_validation_slow` (3 s, past a 2.5 s checkout timeout),
`address_validation_no_verdict` (200 `{"result": {}}`: not something Google sends, for a
client's defensive branch) and `address_validation_dpv_n` (DPV `N`). `GET /__admin/metrics`
counts `ValidateAddress` on its own.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the base URL (the JS shim served under a
prefix calls back through it), or by API key:
`PUT /__admin/credentials {"credentials": {"<PLACES_KEY>": "<namespace>"}}` (the `key` query
parameter, or `X-Goog-Api-Key` for Address Validation, is the credential). The request journal
records operation, status, the resolved `placeId` and the `sessionToken`, and for
`ValidateAddress` the resolved corpus row id (`addressRowId`) and the verdict class
(`ACCEPT/Y`, `FIX/N`, …); never the typed address.

### Tests

- `google-maps.property.test.ts`: self-parity over random walks of all four web services (each
  exercised, every response validated against the spec) and a deliberately divergent instance
  caught.
- `google-maps.acceptance.test.ts`: drives `test/consumer.ts`, a port of our
  `address-autocomplete-native-rest.tsx` (URL builders, parsers, the two-consecutive-failures
  manual-entry switch), `parse-place-details.ts`, `address-autocomplete-web.tsx` and
  `use-geocoded-address.ts` (native REST and web through the shim evaluated in a fake window).
  Also served over HTTP.
- `google-maps.address-validation.acceptance.test.ts`: every Address Validation verdict class,
  the 400/403 envelopes, namespaces, the journal and each preset, through `test/consumer.ts`'s
  port of a checkout's fail-open ship-to evaluation (non-2xx, no verdict → unavailable; USPS
  error, granularity, incomplete, `FIX`/`CONFIRM_ADD_SUBPREMISES`, critical unconfirmed
  components, DPV other than `Y`/`S` → reject). Self-parity walks include `ValidateAddress`.
- There is no SDK drop-in test: native uses plain `fetch`, and the web SDK is Google's hosted
  script, which the shim replaces.
- `bun scripts/parity.ts`: live parity against `maps.googleapis.com` (and
  `addressvalidation.googleapis.com` for `ValidateAddress`) with
  `GOOGLE_MAPS_API_KEY` (env / `.env.local`; Address Validation must be enabled on
  the key); exits 2 without it.

### Deliberately not modelled

- Addresses outside the corpus: only corpus rows and streets synthesized in corpus cities
  resolve. Add more with `PUT /__admin/corpus`.
- Google's route expansion (`N Central Ave` → long_name `North Central Avenue`): `long_name`
  echoes the corpus spelling so QA's line1 round-trips. Live parity will show this difference.
- Maps rendering (`google.maps.Map`, markers, tiles, Static Maps), the new Places API
  (`places.googleapis.com`, `Place` class, `AutocompleteSuggestion`), reverse geocoding
  (`latlng=`), `locationbias`/`radius`, and billing/quotas beyond the presets.
- Session-token billing semantics: tokens are accepted and journaled, nothing more.
- Address Validation beyond `validateAddress`: `provideValidationFeedback`, `previousResponseId`
  chaining, `languageOptions` and `sessionToken` (accepted, ignored), `metadata`
  (business/residential/PO box), `englishLatinAddress`, and non-US regions (without
  `enableUspsCass` they get a `FIX` answer and no `uspsData`; Google validates many countries).
  ZIP+4 digits, `dpvFootnote` codes and the rest of the USPS record (carrier route, delivery
  point, county FIPS…) are synthesized or omitted: compare verdict classes and DPV codes, not
  those.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `GoogleMapsAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `corpus()`, `state`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `corpus`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, journal). Options: `corpus`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `GOOGLE_MAPS_PRESETS` | object | Every named fault preset. |
| `GOOGLE_MAPS_NAMESPACE` | string | The service name, `"google-maps"`. |
| `keyCredential` | function | The `key` query parameter (or `X-Goog-Api-Key` header) of a request (how API keys map to namespaces). |
| `DEFAULT_CORPUS`, `PHOENIX_DEMO_ADDRESS`, `STATE_NAMES` | values | The address corpus, the Phoenix demo member row, and state names for `administrative_area_level_1`. |
| `corpusPlaceId` | function | The stable place id of a corpus row. |
| `mapsJavaScript` | function | Render the Maps JavaScript shim for `{base, key, authFailed, callback}`. |
| `normalize` | function | The address normalization used for matching. |
| `MISSING_KEY_MESSAGE`, `INVALID_KEY_MESSAGE` | strings | Google's `error_message` for a missing / refused key. |
| `MISSING_API_KEY_MESSAGE`, `INVALID_API_KEY_MESSAGE` | strings | Address Validation's `error.message` for a missing (403) / invalid (400) key. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--api-key`, `--public-url`); port 8814. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
