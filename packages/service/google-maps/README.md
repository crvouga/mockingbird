# @crvouga/mockingbird-service-google-maps

Mock of the **Google Maps Platform** surface our member app uses for addresses: Places
Autocomplete, Place Details and Find Place From Text (the JSON web services), the Geocoding API,
and a **Maps JavaScript API shim** (`/maps/api/js?libraries=places`) exposing
`google.maps.places.*` and `google.maps.Geocoder` over the same data. Answers come from a corpus
matching our QA fixtures, so the address step that waits 5 s for Google predictions (and then
falls back to manual entry) resolves instantly and deterministically.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/google-maps/SUPPORT.md)
- Google publishes no OpenAPI document for these endpoints: `openapi.yaml` is hand-authored
  from Google's documented shapes and the fields our consumer reads.

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
| `GET /maps/api/js` | The shim (`text/javascript`): `google.maps.places.AutocompleteService#getPlacePredictions`, `PlacesService#getDetails` / `#findPlaceFromQuery`, `AutocompleteSessionToken`, `PlacesServiceStatus`, `google.maps.Geocoder#geocode`, `GeocoderStatus`, `LatLng` (`lat()`/`lng()`), `LatLngBounds`, `importLibrary`. Callbacks and promises (rejecting with `MapsRequestError` on errors when no callback is given). Calls `window[callback]` for `&callback=`, and `window.gm_authFailure()` when the key is refused. |

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
| `PUT /__admin/corpus` | `{addresses: [{line1, city, state, zip, id?, county?, lat?, lng?}]}` replaces the namespace's custom addresses (on top of the built-in corpus). |
| `DELETE /__admin/corpus` | Drop the custom addresses. |
| `GET/PUT /__admin/settings` | `{keys?: string[], publicUrl?: string \| null}`. `keys` restricts accepted API keys (others get `REQUEST_DENIED` "The provided API key is invalid."; a missing key always does). `publicUrl` is the origin the JS shim calls back to when it differs from the request's (a rewriting proxy). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`over_query_limit`, `request_denied`, `unknown_error`, `zero_results` (every web service, HTTP 200
with that status), `geocode_zero_results` (exercises our Find Place fallback),
`autocomplete_over_query_limit` (two of these flip our sheet to manual entry), `server_error`
(HTTP 500), `slow` (6 s, past QA's 5 s wait), `script_unavailable` (the JS loader answers 503, so
the script's `onerror` fires).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the base URL (the JS shim served under a
prefix calls back through it), or by API key:
`PUT /__admin/credentials {"credentials": {"<PLACES_KEY>": "<namespace>"}}` (the `key` query
parameter is the credential). The request journal records operation, status, the resolved
`placeId` and the `sessionToken`; never the typed address.

### Tests

- `google-maps.property.test.ts`: self-parity over random walks of all four web services (each
  exercised, every response validated against the spec) and a deliberately divergent instance
  caught.
- `google-maps.acceptance.test.ts`: drives `test/consumer.ts`, a port of our
  `address-autocomplete-native-rest.tsx` (URL builders, parsers, the two-consecutive-failures
  manual-entry switch), `parse-place-details.ts`, `address-autocomplete-web.tsx` and
  `use-geocoded-address.ts` (native REST and web through the shim evaluated in a fake window).
  Also served over HTTP.
- There is no SDK drop-in test: native uses plain `fetch`, and the web SDK is Google's hosted
  script, which the shim replaces.
- `bun scripts/parity.ts`: live parity against `maps.googleapis.com` with
  `MOCKINGBIRD_GOOGLE_MAPS_API_KEY` (env or Vault `secret/personal/prd`); exits 2 without it.

### Deliberately not modelled

- Addresses outside the corpus: only corpus rows and streets synthesized in corpus cities
  resolve. Add more with `PUT /__admin/corpus`.
- Google's route expansion (`N Central Ave` → long_name `North Central Avenue`): `long_name`
  echoes the corpus spelling so QA's line1 round-trips. Live parity will show this difference.
- Maps rendering (`google.maps.Map`, markers, tiles, Static Maps), the new Places API
  (`places.googleapis.com`, `Place` class, `AutocompleteSuggestion`), reverse geocoding
  (`latlng=`), `locationbias`/`radius`, and billing/quotas beyond the presets.
- Session-token billing semantics: tokens are accepted and journaled, nothing more.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `GoogleMapsAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `corpus()`, `state`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `corpus`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, journal). Options: `corpus`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `GOOGLE_MAPS_PRESETS` | object | Every named fault preset. |
| `GOOGLE_MAPS_NAMESPACE` | string | The service name, `"google-maps"`. |
| `keyCredential` | function | The `key` query parameter of a request (how API keys map to namespaces). |
| `DEFAULT_CORPUS`, `PHOENIX_DEMO_ADDRESS`, `STATE_NAMES` | values | The address corpus, the Phoenix demo member row, and state names for `administrative_area_level_1`. |
| `corpusPlaceId` | function | The stable place id of a corpus row. |
| `mapsJavaScript` | function | Render the Maps JavaScript shim for `{base, key, authFailed, callback}`. |
| `normalize` | function | The address normalization used for matching. |
| `MISSING_KEY_MESSAGE`, `INVALID_KEY_MESSAGE` | strings | Google's `error_message` for a missing / refused key. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--api-key`, `--public-url`); port 8814. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
