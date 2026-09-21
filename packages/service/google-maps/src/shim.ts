/**
 * The Maps JavaScript API shim served at `GET /maps/api/js`: `google.maps.places.*` and
 * `google.maps.Geocoder`, backed by this mock's own REST endpoints (same corpus, same faults,
 * same namespace), in the callback shapes and status enums the real script uses.
 */
export type ShimOptions = {
  /** Origin (plus any `/ns/<name>` prefix) the shim's `fetch` calls go to. */
  base: string
  key: string
  /** The key was refused: the shim calls `window.gm_authFailure()` once loaded. */
  authFailed: boolean
  /** `&callback=` from the script URL, called once `google.maps` is ready. */
  callback: string | null
}

/** JSON embedded in a `<script>` body, with `<` escaped so `</script>` cannot close it. */
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c")

export const mapsJavaScript = (
  options: ShimOptions,
): string => `/* Mockingbird Google Maps JavaScript API shim (places, geocoder) */
(function () {
  var BASE = ${embed(options.base)};
  var KEY = ${embed(options.key)};
  var AUTH_FAILED = ${options.authFailed ? "true" : "false"};
  var CALLBACK = ${embed(options.callback)};
  var w = typeof window !== "undefined" ? window : globalThis;
  var doFetch = (w.fetch && w.fetch.bind(w)) || fetch;

  function request(path, params) {
    var parts = [];
    for (var name in params) {
      var value = params[name];
      if (value === undefined || value === null || value === "") continue;
      parts.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(value)));
    }
    parts.push("key=" + encodeURIComponent(KEY));
    return doFetch(BASE + path + "?" + parts.join("&")).then(
      function (response) {
        if (!response.ok) return { status: "UNKNOWN_ERROR" };
        return response.json().then(null, function () { return { status: "UNKNOWN_ERROR" }; });
      },
      function () { return { status: "UNKNOWN_ERROR" }; }
    );
  }

  function LatLng(lat, lng) { this._lat = Number(lat); this._lng = Number(lng); }
  LatLng.prototype.lat = function () { return this._lat; };
  LatLng.prototype.lng = function () { return this._lng; };
  LatLng.prototype.toJSON = function () { return { lat: this._lat, lng: this._lng }; };
  LatLng.prototype.toString = function () { return "(" + this._lat + ", " + this._lng + ")"; };
  LatLng.prototype.equals = function (other) { return !!other && other.lat() === this._lat && other.lng() === this._lng; };

  function LatLngBounds(sw, ne) { this._sw = sw; this._ne = ne; }
  LatLngBounds.prototype.getSouthWest = function () { return this._sw; };
  LatLngBounds.prototype.getNorthEast = function () { return this._ne; };
  LatLngBounds.prototype.toJSON = function () {
    return { south: this._sw.lat(), west: this._sw.lng(), north: this._ne.lat(), east: this._ne.lng() };
  };

  function wrapGeometry(g) {
    if (!g || !g.location) return g;
    var out = { location: new LatLng(g.location.lat, g.location.lng) };
    if (g.location_type) out.location_type = g.location_type;
    if (g.viewport) {
      out.viewport = new LatLngBounds(
        new LatLng(g.viewport.southwest.lat, g.viewport.southwest.lng),
        new LatLng(g.viewport.northeast.lat, g.viewport.northeast.lng)
      );
    }
    return out;
  }

  function wrapPlace(p) {
    if (!p) return p;
    var out = {};
    for (var k in p) out[k] = p[k];
    if (p.geometry) out.geometry = wrapGeometry(p.geometry);
    return out;
  }

  var PlacesServiceStatus = {
    OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", INVALID_REQUEST: "INVALID_REQUEST",
    OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED",
    UNKNOWN_ERROR: "UNKNOWN_ERROR", NOT_FOUND: "NOT_FOUND"
  };
  var GeocoderStatus = {
    OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", INVALID_REQUEST: "INVALID_REQUEST",
    OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED",
    UNKNOWN_ERROR: "UNKNOWN_ERROR", ERROR: "ERROR"
  };

  function MapsRequestError(status, endpoint) {
    var error = new Error(endpoint + ": " + status);
    error.name = "MapsRequestError";
    error.code = status;
    error.endpoint = endpoint;
    return error;
  }

  /** Call back, or settle the returned promise (rejecting on errors) when there is no callback. */
  function settle(callback, results, status, value, endpoint, okStatuses) {
    if (typeof callback === "function") {
      callback(results, status);
      return value;
    }
    if (okStatuses.indexOf(status) < 0) throw MapsRequestError(status, endpoint);
    return value;
  }

  var tokenSeq = 0;
  function AutocompleteSessionToken() {
    tokenSeq += 1;
    this._id = "mbst-" + tokenSeq + "-" + Math.random().toString(36).slice(2, 10);
  }
  AutocompleteSessionToken.prototype.toString = function () { return this._id; };

  function countries(restrictions) {
    if (!restrictions || !restrictions.country) return undefined;
    var list = [].concat(restrictions.country);
    return list.map(function (c) { return "country:" + String(c).toLowerCase(); }).join("|");
  }

  function fieldList(fields) {
    if (!fields) return undefined;
    return [].concat(fields).join(",");
  }

  function AutocompleteService() {}
  AutocompleteService.prototype.getPlacePredictions = function (req, callback) {
    req = req || {};
    return request("/maps/api/place/autocomplete/json", {
      input: req.input,
      sessiontoken: req.sessionToken ? String(req.sessionToken) : undefined,
      types: req.types ? [].concat(req.types).join("|") : undefined,
      components: countries(req.componentRestrictions)
    }).then(function (data) {
      var status = data.status || "UNKNOWN_ERROR";
      var predictions = status === "OK" ? data.predictions : null;
      return settle(callback, predictions, status, { predictions: predictions || [] },
        "PLACES_AUTOCOMPLETE", ["OK", "ZERO_RESULTS"]);
    });
  };

  function PlacesService(attributions) { this._attributions = attributions || null; }
  PlacesService.prototype.getDetails = function (req, callback) {
    req = req || {};
    return request("/maps/api/place/details/json", {
      place_id: req.placeId,
      fields: fieldList(req.fields),
      sessiontoken: req.sessionToken ? String(req.sessionToken) : undefined
    }).then(function (data) {
      var status = data.status || "UNKNOWN_ERROR";
      var place = status === "OK" ? wrapPlace(data.result) : null;
      return settle(callback, place, status, place, "PLACES_GET_PLACE", ["OK"]);
    });
  };
  PlacesService.prototype.findPlaceFromQuery = function (req, callback) {
    req = req || {};
    return request("/maps/api/place/findplacefromtext/json", {
      input: req.query,
      inputtype: "textquery",
      fields: fieldList(req.fields)
    }).then(function (data) {
      var status = data.status || "UNKNOWN_ERROR";
      var results = status === "OK" ? (data.candidates || []).map(wrapPlace) : null;
      return settle(callback, results, status, { results: results || [] },
        "PLACES_FIND_PLACE_FROM_QUERY", ["OK", "ZERO_RESULTS"]);
    });
  };

  function Geocoder() {}
  Geocoder.prototype.geocode = function (req, callback) {
    req = req || {};
    return request("/maps/api/geocode/json", {
      address: req.address,
      place_id: req.placeId,
      components: req.componentRestrictions && req.componentRestrictions.postalCode
        ? "postal_code:" + req.componentRestrictions.postalCode : undefined
    }).then(function (data) {
      var status = data.status || "ERROR";
      var results = status === "OK" ? (data.results || []).map(wrapPlace) : null;
      return settle(callback, results, status, { results: results || [] }, "GEOCODER_GEOCODE", ["OK"]);
    });
  };

  w.google = w.google || {};
  w.google.maps = {
    version: "mockingbird",
    LatLng: LatLng,
    LatLngBounds: LatLngBounds,
    Geocoder: Geocoder,
    GeocoderStatus: GeocoderStatus,
    places: {
      AutocompleteService: AutocompleteService,
      AutocompleteSessionToken: AutocompleteSessionToken,
      PlacesService: PlacesService,
      PlacesServiceStatus: PlacesServiceStatus
    },
    importLibrary: function (name) {
      if (name === "places") return Promise.resolve(w.google.maps.places);
      if (name === "geocoding") return Promise.resolve({ Geocoder: Geocoder, GeocoderStatus: GeocoderStatus });
      return Promise.resolve({ LatLng: LatLng, LatLngBounds: LatLngBounds });
    }
  };

  if (AUTH_FAILED) {
    setTimeout(function () { if (typeof w.gm_authFailure === "function") w.gm_authFailure(); }, 0);
  }
  if (CALLBACK && typeof w[CALLBACK] === "function") w[CALLBACK]();
})();
`
