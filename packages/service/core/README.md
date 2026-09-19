# @crvouga/mockingbird-service

The generic runtime behind every Mockingbird provider mock: turns an OpenAPI document plus one handler
per `operationId` into a Fetch-native `FetchAPI` (Hono routing), with SQLite-backed collections,
deterministic ids, bracket-decoded queries/bodies and schema-driven form parsing. Use it to build a
mock for an API Mockingbird does not ship. To mock Stripe, Junction, etc., install that provider
package (e.g. `@crvouga/mockingbird-service-stripe`) instead.

## Install

```bash
npm install @crvouga/mockingbird-service @crvouga/mockingbird-openapi
```

ESM only, portable (Node >=22, Bun >=1.2, workers). `@crvouga/mockingbird-openapi` provides
`parseOpenAPIDocument` and the `OpenAPIDocument` type used below.

## Usage

```ts
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import {
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  HttpError,
  IdSequence,
  jsonRes,
} from "@crvouga/mockingbird-service"

const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "Widgets", version: "1" },
  paths: {
    "/v1/widgets": {
      post: { operationId: "widgets.create", responses: { "200": { description: "ok" } } },
    },
    "/v1/widgets/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "widgets.retrieve", responses: { "200": { description: "ok" } } },
    },
  },
})

type Widget = { id: string; name: string; created: number }

const sqlite = bootSqlite() // in-memory by default; runs core migrations
const widgets = new Collection<Widget>(sqlite, "widgets", "widgets")
const ids = new IdSequence(sqlite, "widgets")

const handlers = defineOperations<"widgets.create" | "widgets.retrieve">({
  "widgets.create": ({ body, now }) => {
    const name = body.kind === "json" || body.kind === "form" ? body.value : undefined
    if (typeof name !== "object" || name === null || !("name" in name)) {
      throw new HttpError(400, { error: "name is required" })
    }
    const widget: Widget = { id: ids.next("wid_"), name: String(name.name), created: now() }
    widgets.insert(widget.id, widget)
    return jsonRes(200, widget)
  },
  "widgets.retrieve": ({ params }) => {
    const widget = widgets.get(params.id ?? "")
    if (!widget) throw new HttpError(404, { error: "no such widget" })
    return jsonRes(200, widget)
  },
})

const api = createService({
  document,
  handlers,
  sqlite,
  namespace: "widgets",
  notFound: () => jsonRes(404, { error: "unknown route" }),
  onError: (error) =>
    error instanceof HttpError ? error.toResponse() : jsonRes(500, { error: "internal" }),
  before: ({ request }) =>
    request.headers.has("authorization") ? undefined : jsonRes(401, { error: "unauthorized" }),
})

const created = await api.fetch(
  new Request("https://mock.local/v1/widgets", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/x-www-form-urlencoded" },
    body: "name=Sprocket",
  }),
)
console.log(await created.json()) // { id: "wid_...", name: "Sprocket", created: ... }
await api.reset() // wipes every record and id sequence in the "widgets" namespace
```

`createService` throws `OperationRegistryError` unless handlers match the document exactly: one per
supported operation, none for unknown ids or operations marked `x-mockingbird: { supported: false }`
(those answer via `unsupported`, else `notFound`). Static path segments win over parameters
(`/v1/widgets/search` beats `/v1/widgets/{id}`). `before` runs only for supported operations, after
the body is read.

## API

| Export | Signature / shape | Description |
| --- | --- | --- |
| `createService` | `(options: ServiceOptions) => Service` | Build the routed `FetchAPI`; verifies handlers and runs core migrations. |
| `bootSqlite` | `(sqlite?: SqliteClient) => SqliteClient` | Injected client or a new in-memory one, core-migrated. Call first in a constructor. |
| `defineOperations` | `<Id>(handlers: Record<Id, OperationHandler>) => Record<Id, OperationHandler>` | Identity helper that type-checks a handler map against an id union. |
| `verifyOperations` | `(document, handlers) => string[]` | Registry problems (missing, extra, unsupported-with-handler, duplicate ids); `[]` if consistent. |
| `OperationRegistryError` | `class extends Error { problems: string[] }` | Thrown by `createService` when `verifyOperations` finds problems. |
| `Collection` | `new Collection<T>(sqlite, namespace, name)` | JSON records by id: `get`, `has`, `insert` (upsert; moves to newest), `update` (keeps position; `undefined` if missing), `delete`, `list({ where?, order?: "newest" \| "oldest" })` (default newest first), `nextSequence`. |
| `IdSequence` | `new IdSequence(sqlite, namespace, salt = "mockingbird")` | `next(prefix, length = 14)` gives deterministic ids like `cus_` + 14 alphanumerics, stable for a given history. |
| `opaqueToken` | `(input: string, length: number) => string` | Deterministic alphanumeric token derived from `input` (non-cryptographic). |
| `jsonRes` | `(status, body, headers?) => Response` | JSON response with `content-type: application/json`. |
| `jsonResponse` | alias of `jsonRes` | |
| `HttpError` | `new HttpError(status, body, headers = {})` | Throw from handlers; `toResponse()` gives JSON, or plain text if `headers["content-type"]` is `text/plain`. Convert it in `onError`. |
| `coerce` | `{ string, integer, boolean, enumeration, stringMap }` | Coerce form strings like servers do; each returns `FieldResult<T>`. `boolean` accepts `true`/`false`/`1`/`0`. |
| `codePointLength` | `(value: string) => number` | String length in Unicode code points (JSON Schema `maxLength` semantics). |
| `parseForm` | `(document, schema, raw: FormValue \| undefined, path?) => ParsedForm` | Validate and coerce a bracket-decoded form value against an OpenAPI schema. |
| `sortIssues` | `(issues: FormIssue[]) => FormIssue[]` | Stable sort: `unknown`, then `missing`, then value errors. |

Types:

- `ServiceOptions`: `{ document; handlers; sqlite; namespace; now?; notFound(request); unsupported?(request, operation); onError(error, request); before?(context) }`.
- `Service`: `FetchAPI & { app: Hono; sqlite; namespace; reset(): Promise<void> }`.
- `OperationContext` (handler argument): `{ request; url; params; query: FormObject; body: DecodedBody; sqlite; namespace; operation; now }`.
- `OperationHandler`: `(context) => Response | Promise<Response>`; `OperationHandlers`: `Record<string, OperationHandler>`.
- `APIOptions`: `{ sqlite?: SqliteClient; now?: () => number }`, the options every provider mock accepts.
- `Stored<T>` / `ListRecordsOptions<T>`, `FieldResult<T>` (`{ ok: true; value } | { ok: false; reason }`),
  `ParsedForm` (`{ value; issues }`) and `FormIssue` (`{ kind, path, ... }`, bracket-notation paths).

## Related

- `@crvouga/mockingbird-core`: the `FetchAPI` contract `Service` implements.
- `@crvouga/mockingbird-sqlite`: the `SqliteClient` port and migrations.
- `@crvouga/mockingbird-http-codec`: the body/query codecs behind `OperationContext`.
- `@crvouga/mockingbird-openapi`, `@crvouga/mockingbird-openapi-metadata`: document parsing and `x-mockingbird` metadata.
- `@crvouga/mockingbird-adapter-node` / `@crvouga/mockingbird-adapter-bun`: serve the result over HTTP.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
