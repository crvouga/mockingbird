# @crvouga/mockingbird-service-payload-cms

Stateful mock of **Payload CMS**'s collection REST API for test suites: `GET /api/<collection>`
with Payload's paginated envelope (`docs`, `totalDocs`, `limit`, `totalPages`, `page`,
`pagingCounter`, `hasPrevPage`, `hasNextPage`, `prevPage`, `nextPage`) and a `where` query
subset, and `GET /api/<collection>/<id>`. The `marketing` collection is seeded with an active
referral card, so the backend's referral content comes from the "CMS" deterministically, and
the admin plane lets a test change it.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/payload-cms/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from Payload's REST and query docs and the
  consumer's response type (`payload-cms-response.type.ts`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-payload-cms
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-payload-cms serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point `PAYLOAD_CMS_API_URL` at the mock. The backend validates it as **https-only**
(`validation.schema.ts`), so either relax that for loopback or put the mock behind TLS.
Anything that goes wrong (non-2xx, empty docs, bad JSON, a dropped connection) makes the
backend fall back to its default referral content, which the presets exercise.

```bash
npx mockingbird-payload-cms serve --port 8822
# or seed your own collections: --collections ./cms-seed.json   ({"marketing": [ … ]})
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-payload-cms"

const cms = createRuntime()
await cms.fetch(
  new Request("http://cms.test/__admin/collections/marketing/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Fall", type: "referral", isActive: true, cardTitle: "Fall Rewards" }),
  }),
)
const page = await cms.fetch(
  new Request(
    "http://cms.test/api/marketing?where[type][equals]=referral&where[isActive][equals]=true&limit=1",
  ),
)
// → {docs: [{id: 4, cardTitle: "Fall Rewards", …}], totalDocs: 2, limit: 1, …}
```

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /api/<collection>` | `where[<field>][<op>]=<value>` with `equals`, `not_equals`, `in` / `not_in` (comma lists), `exists`, `greater_than(_equal)`, `less_than(_equal)`, `like` (all words, case-insensitive), `contains`; nested `where[and\|or][<i>][…]`; dotted field paths. Values are cast to the document field's type (`"true"` → `true`). `sort=<field>` / `-<field>` (default `-createdAt`), `limit` (default 10; `0` = no limit), `page`. An unknown field is 400 `{errors: [{message: "The following path cannot be queried: <field>"}]}`; an unknown collection 404. `depth`, `locale`, `draft` are accepted and ignored. |
| `GET /api/<collection>/<id>` | The document, or 404 `{errors: [{message: "The requested resource was not found."}]}`. |

Only `marketing` is declared in the contract (it is what our backend reads); any collection
seeded through the admin plane is served the same way. Ids are integers (Payload's Postgres
adapter), matching the consumer's `id: number`.

**Seed** (`DEFAULT_MARKETING_DOCS`): `1` an inactive referral card, `2` the active referral
card, `3` an active banner.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/collections` | `{collections: {<slug>: <doc count>}}`. |
| `GET /__admin/collections/:slug` | The collection's documents. |
| `PUT /__admin/collections/:slug` | `{docs: [...]}` replaces the collection (creates it if new). |
| `POST /__admin/collections/:slug/docs` | Adds a document (next integer id, timestamps from the mock clock). |
| `PATCH /__admin/collections/:slug/docs/:id` | Merges fields into a document. |
| `DELETE /__admin/collections/:slug/docs/:id` | Removes a document. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `server_error` (500),
`forbidden` (403), `collection_not_found` (404), `no_active_docs` (an empty page),
`malformed_json` (200 HTML), `unavailable` (503 HTML), `connection_drop`, `slow` (10 s).

### Namespaces

Our backend's `fetch` sends no credential, so use a `/ns/<name>` suffix on
`PAYLOAD_CMS_API_URL` (e.g. `http://127.0.0.1:8822/ns/worker-1`) or `x-mockingbird-namespace`.
A request carrying `Authorization: <collection> API-Key <key>` or a bearer token can also be
mapped with `PUT /__admin/credentials`.

### Deliberately not modelled

- Writes through the REST API (create/update/delete), auth endpoints, access control, drafts,
  versions, locales, relationship population (`depth`), uploads and GraphQL.
- `where` operators beyond the subset above (`near`, `within`, `intersects`, `all`).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PayloadCmsAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `addDoc(slug, fields)`, `updateDoc(slug, id, patch)`, `deleteDoc(slug, id)`, `collections()`. Options: `sqlite`, `now`, `namespace`, `collections`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, presets). Options: `collections`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `PAYLOAD_CMS_PRESETS` | object | Every named fault preset. |
| `PAYLOAD_CMS_NAMESPACE` | string | The service name, `"payload-cms"`. |
| `DEFAULT_MARKETING_DOCS` | array | The marketing collection seed. |
| `MARKETING_FIELDS` | array | The marketing collection's queryable fields. |
| `compileWhere` | function | Compile a Payload `where` object into a predicate (or the 400 message). |
| `payloadCredential` | function | The API key or bearer token a request carries. |
| `payloadError` | function | Build a Payload error response `{errors: [{message}]}`. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--collections <file>`); port 8822. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
