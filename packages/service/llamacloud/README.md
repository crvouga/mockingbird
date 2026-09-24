# @crvouga/mockingbird-service-llamacloud

Stateful mock of the **LlamaCloud** platform API (LlamaIndex's managed indexes) for test suites:
project and pipeline lookup, pipeline documents (list, get, insert, upsert, delete), and
retrieval. Retrieval is deterministic: a scripted answer when a test sets one, otherwise a
term-overlap ranking over the documents in the pipeline. The chat knowledge tools
(`search_health_knowledge`, `search_faq`) and the EMR chatbot-admin knowledge CRUD run against
it with no vendor account, no embeddings and no nondeterminism.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/llamacloud/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from the official Python client's wire models
  (llama-cloud 0.1.45) and our backend adapter.

## Install

```bash
npm install -D @crvouga/mockingbird-service-llamacloud
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-llamacloud serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

```bash
npx mockingbird-llamacloud serve --port 8805 --index acme-member-kb-v1 --project Default
```

Point the app at it:

| Consumer | Setting |
| --- | --- |
| Backend `LlamaCloudKnowledgeAdapter` | `LLAMACLOUD_BASE_URL=http://127.0.0.1:8805/api/v1` (seam **G-L1**: the adapter hardcodes `https://api.cloud.llamaindex.ai/api/v1` today), plus `LLAMACLOUD_API_KEY` (any value) and `LLAMACLOUD_INDEX_NAME` / `LLAMACLOUD_PROJECT_NAME` matching a seeded pipeline |
| Python chat service (`llama_cloud_services`) | `LLAMA_CLOUD_BASE_URL=http://127.0.0.1:8805` (no `/api/v1`; verified below, no code change needed) |

```ts
import { createRuntime } from "@crvouga/mockingbird-service-llamacloud"

const llama = createRuntime({ pipelines: [{ name: "acme-member-kb-v1", projectName: "Default" }] })
const admin = (path: string, body: unknown) =>
  llama.fetch(
    new Request(`http://llamacloud.test/__admin${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

// Script what the chat tool retrieves for queries mentioning "apob"…
await admin("/retrieval", {
  match: { contains: "apob" },
  nodes: [{ text: "ApoB counts atherogenic particles.", score: 0.92, metadata: { file_name: "apob.md" } }],
})
// …anything else is ranked by term overlap over the documents the app upserted.
```

### Routes

All under `Authorization: Bearer <key>` (any non-empty key unless `apiKeys` is set). Errors are
FastAPI-shaped: `{"detail": "…"}`, and 422 `{"detail": [{loc, msg, type}]}`.

| Route | Behaviour |
| --- | --- |
| `GET /api/v1/projects?project_name=` | Projects with that exact name (`[]` when none). |
| `GET /api/v1/projects/{id}` | One project, or 404. |
| `GET /api/v1/pipelines?project_name=&project_id=&pipeline_name=&pipeline_type=` | Pipelines matching every filter given: `[{id, name, project_id, pipeline_type: "MANAGED", embedding_config, status: "CREATED", …}]`. The backend filters by `project_name` and picks `name == LLAMACLOUD_INDEX_NAME`. |
| `GET /api/v1/pipelines/{id}` | One pipeline, or 404. |
| `POST /api/v1/pipelines/{id}/retrieve` | `{query, dense_similarity_top_k?, …}` → `{pipeline_id, retrieval_nodes: [{node: {id_, text, metadata, extra_info, …}, score}], …}`. Top-k defaults to 5. |
| `GET /api/v1/pipelines/{id}/documents?skip=&limit=` | `[{id, text, metadata, …}]`, oldest first. |
| `PUT /api/v1/pipelines/{id}/documents` | Upsert `[{id?, text, metadata}]` by id (the backend uses the slug); a missing id gets a UUID. Answers the stored documents. |
| `POST /api/v1/pipelines/{id}/documents` | Same as PUT (the SDK's `insert`). |
| `GET /api/v1/pipelines/{id}/documents/{docId}` | One document, or 404. |
| `DELETE /api/v1/pipelines/{id}/documents/{docId}` | 204, or 404 for an unknown document. |

### Retrieval

1. **Scripted.** `PUT /__admin/retrieval {match: {contains?, pipeline?}, nodes: [{text, score?, metadata?}]}`
   adds a rule. The most recently added rule whose `contains` appears in the query
   (case-insensitive) and whose `pipeline` (id or name) matches answers its `nodes` verbatim,
   truncated to top-k. A node without a score gets 1, 0.9, 0.8, … Node ids are `scripted_<n>`.
2. **Default: term overlap.** Terms are lower-cased alphanumeric words of 2+ characters minus
   common stopwords. A document's score is the share of the query's distinct terms found in its
   text or `metadata.title`, rounded to 4 places. Non-matching documents are dropped and ties
   keep insertion order. Each document is one node (`id_: "<docId>_0"`), and its metadata gains
   `document_id` and `pipeline_id`, the fields the backend reads.

Node metadata is sent under both `metadata` (read by our backend) and `extra_info` (the
official client model's field name). Without live credentials, which of the two the real API
sends is unverified.

### Python chat SDK: verified call sequence

The catalog listed this as unverified. It has now been checked against the installed SDK:
llama-cloud-services **0.6.88**, llama-cloud **0.1.45** and llama-index-core **0.14.10**, the
versions the consumer app's Python chat service pins. The wheels were read, and
`llamacloud.sdk.test.ts` runs that service's real `LlamaCloudClient` file on the real SDK against the
served mock. `LlamaCloudIndex(name, project_name=…, api_key=…)` followed by
`.as_retriever(similarity_top_k=5).aretrieve(q)` makes these calls:

1. `GET /api/v1/projects?project_name=<name>`: `resolve_project`. No match raises
   `No project found with name …`, and more than one match raises too.
2. `GET /api/v1/pipelines?project_id=<id>&pipeline_name=<index>&pipeline_type=MANAGED`:
   `resolve_pipeline`. No match raises `Unknown index name …`.
3. `GET /api/v1/pipelines/{id}`, then `GET /api/v1/projects/{project_id}`: `as_retriever()`
   builds a `LlamaCloudRetriever(project_id=…, pipeline_id=…)`, which resolves both again by id.
4. `POST /api/v1/pipelines/{id}/retrieve {query, dense_similarity_top_k: 5}`.

The base URL comes from `base_url` or `LLAMA_CLOUD_BASE_URL`, falling back to
`https://api.cloud.llamaindex.ai` (`llama_index.core.ingestion.api_utils.get_client`). The
client passes no `base_url`, so setting the environment variable is enough. The SDK's pydantic models
are strict: `Pipeline.status` must be `CREATED` or `DELETING`, and `embedding_config` is
required. The mock satisfies both, and the SDK test fails if a shape drifts.

**Discrepancy:** the Python client's `llamacloud_project_name` defaults to `"default"` (lowercase). The
backend's default is `"Default"`. Project lookup is exact, so it needs
`LLAMACLOUD_PROJECT_NAME=Default`, or a seeded `default` project. Otherwise the client degrades
to empty results, which the acceptance tests cover.

To run the SDK test:

```bash
uv venv /tmp/llama && VIRTUAL_ENV=/tmp/llama uv pip install \
  llama-cloud-services==0.6.88 llama-cloud==0.1.45 llama-index-core==0.14.10
MOCKINGBIRD_LLAMACLOUD_PYTHON=/tmp/llama/bin/python \
  MOCKINGBIRD_LLAMACLOUD_PY_CLIENT=/path/to/llamacloud_client.py bun test llamacloud.sdk
```

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/pipelines` | The namespace's projects and pipelines. |
| `PUT /__admin/pipelines` | `{name, projectName?}` creates a managed pipeline, and its project if needed. The ids are stable UUIDs derived from the namespace and names. |
| `GET /__admin/pipelines/:pipeline/documents` | A pipeline's documents, by id or name. |
| `GET /__admin/retrieval` | The scripted rules, newest first. |
| `PUT /__admin/retrieval` | Add one rule, or replace them all with `{rules: [...]}` (the first listed wins). |
| `DELETE /__admin/retrieval` | Clear the rules. |
| `GET/PUT /__admin/settings` | `{apiKeys?: string[], defaultTopK?: number}` for the calling namespace. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):

| Preset | Effect |
| --- | --- |
| `index_missing` | Pipeline search answers `[]`. |
| `retrieval_empty` | Retrieval answers no nodes. |
| `documents_unexpected_shape` | The document list answers an object instead of an array. |
| `unauthorized` | Every call answers 401. |
| `rate_limited` | Every call answers 429. |
| `server_error` | Every call answers 500. |
| `slow_retrieval` | Retrieval is delayed by 3 s, or by `latencyMs` when given. |

### Namespaces

Neither consumer can add headers, so a namespace can be chosen three ways:

- the `x-mockingbird-namespace` header;
- a `/ns/<name>` prefix on the base URL;
- the API key: `PUT /__admin/credentials {"credentials": {"<LLAMACLOUD_API_KEY>": "<namespace>"}}`.

Each namespace starts with the seeded pipelines, by default `acme-member-kb-v1` in project
`Default`. The request journal records operation ids, statuses and pipeline and document ids. It
never records queries, document text or titles.

### Deliberately not modelled

- Real retrieval quality: no embeddings, chunking, hybrid search, reranking, metadata filters,
  image or page-figure nodes, or `retrieval_mode` routing. A document is always one node.
- Pipeline ingestion status and sync jobs. Upserted documents can be retrieved immediately.
- File uploads (`/api/v1/files`, `pipeline_files`), data sources, parsing (LlamaParse) and
  extraction.
- Creating projects or pipelines through the API. Use the seed or `PUT /__admin/pipelines`.
- Organizations beyond one per namespace.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `LlamaCloudAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `documents(pipeline)`, `addRule(rule)`, `rules()`, `clearRules()`, `state`. Options: `sqlite`, `now`, `namespace`, `pipelines`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets). Options: `pipelines`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `LLAMACLOUD_PRESETS` | object | Every named fault preset. |
| `LLAMACLOUD_NAMESPACE` | string | The service name, `"llamacloud"`. |
| `DEFAULT_PIPELINES`, `DEFAULT_PIPELINE_NAME`, `DEFAULT_PROJECT_NAME`, `DEFAULT_SETTINGS` | values | The seed: `acme-member-kb-v1` in `Default`, top-k 5, any key. |
| `rank`, `terms` | functions | The default term-overlap ranking and its tokenizer. |
| `uuidFrom` | function | The stable UUID derivation used for project, pipeline and document ids. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--index`, `--project`, `--api-key`); port 8805. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
