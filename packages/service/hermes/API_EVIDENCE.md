# Hermes peer-run API evidence

Research for the public tracked-run mock; no Hermes runtime, inference, provider
credentials, or Kanban dispatcher was executed. Source inspection is not observed
parity. The package remains unimplemented until the later implementation stories.

## Provenance and compatibility target

Retrieved 2026-09-27. Required release: `v2026.8.31` of
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
`git ls-remote` resolved annotated tag object
`6e8f8418e6378eb2617e4de074e13dedd091b8af` to commit
`29112bef099274229cadff79cdff7bf7b99c4b77`. All pinned links below use that commit.
Downloaded source copies are retained under the ignored project directory
`.mockingbird/hermes-evidence/v2026.8.31/`; they were read, not imported or executed.

Context7 resolution selected `/nousresearch/hermes-agent`. Its advertised versions
were `v2026.4.8`, `v2026.4.16`, and `v2026.6.5`; it did not advertise the target.
Two queries covered submission/polling/stopping and idempotency/fingerprint,
profile/session scope, restart and retention. Results referenced current `main`:

- [Programmatic integration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md): asynchronous POST, poll, and stop route descriptions; not exact envelopes.
- [Current run handlers](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server_runs.py): routes and request processing, including newer session-key-to-conversation resolution not present in the pinned handler.
- [Current API guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md): cooperative stopping. This is documentation, not a claim that every stop ends as cancelled.

No unsupported Context7 version was requested or invented. Current-main snippets
have no immutable revision from Context7 and are discovery evidence only.

### Pinned sources

| ID | Source and relevant location | Evidence class |
| --- | --- | --- |
| R | [Run handlers](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/platforms/api_server_runs.py), `_http_routes`, `_handle_runs`, `_handle_get_run`, `_handle_stop_run`, `_durable_run_status`, `_sweep_orphaned_runs_once` | Pinned source |
| I | [Idempotency store](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/platforms/api_server_run_idempotency.py), `RunIdempotencyStore` | Pinned source |
| A | [API adapter](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/platforms/api_server.py), error helper, admission, header parser, concurrency, TTL constants | Pinned source |
| D | [API guide](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/features/api-server.md), tracked-run and session-key sections | Pinned documentation |
| T | [Run tests](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tests/gateway/test_api_server_runs.py), stop races, replay, retention, restart and scope tests | Pinned test source; not run here |

SHA-256 of the retrieved bytes:

| File | SHA-256 |
| --- | --- |
| `api_server_runs.py` | `048ae843592d701ff47437bd8edd47cd64ca6c0fdf88a71045bdb6fb337fbc63` |
| `api_server_run_idempotency.py` | `746904b3b6ed45d8359655b2e87c1f101394b13f6253e718ac9a83acd46174f2` |
| `api_server.py` | `6aec6687d47c81b3567e930882a499c5c5c041ecbe40e1d08f93038212401962` |
| `api-server.md` | `4f2f3f30cdcc4c5635bfba5dff97009120e1a357647715c1935806184d443b29` |
| `test_api_server_runs.py` | `c610484550aef243d05c9dab4d4672e4af1f71161026c838fdaf2b84d886e287` |

## Submission and polling

R lines404–1014 establish `POST /v1/runs`. Admission authenticates and checks
gateway draining first (A `_admit_api_agent_request`). Within the handler:
parse the memory-scope header, parse JSON, normalize room dispatch, validate the
idempotency key, fingerprint, validate input/history/routing, look up an existing
key, then check capacity and atomically reserve a new run. Invalid input and
capacity rejection do not reserve a key; replay precedes capacity rejection.
Drain rejection can still precede replay.

For the ordinary peer path, `input` is a nonempty string or array whose final
item supplies a truthy `content`. Earlier array messages become conversation
history when explicit/resolved history is absent. The pinned code does not check
that the final item's role is `user`; do not invent such validation. It does not
robustly validate arbitrary array elements or every JSON root type; exact malformed
non-object behavior is an oracle gap, not permission to invent a provider envelope.

Optional fields read by R include `instructions`, `session_id`, `model`,
`conversation_history`, `previous_response_id`, and model/provider options through
A `_request_agent_overrides`. Explicit truthy history must be an array of objects
with `role` and `content`; those values are coerced to strings. Explicit history
wins over previous-response history. A missing previous-response record is ignored
by this pinned run handler, unlike the separate Responses API. Transcript loading,
model routing and execution are not inference requirements for the mock; retain
synthetic metadata and script public observations without executing them.

A new run has an opaque `run_` plus UUID-hex ID. The POST response is exactly
HTTP202 with `{ "run_id": "run_<opaque>", "status": "started", "replayed": false }`.
`started` is an admission response, not the stored execution state. Initial stored
state is `queued`, then background execution sets `running`. Echo
`X-Hermes-Session-Key` when the validated header is present; no replay header is
added to a new submission. [R `_handle_runs`; T `test_start_returns_202`]

`GET /v1/runs/{run_id}` returns HTTP200 with the current status object. Normal
newly admitted records contain `object: "hermes.run"`, `run_id`, `status`, numeric
Unix-seconds `created_at` and `updated_at`, `session_id`, and `model`. Session ID
is the supplied/resolved ID or defaults to the run ID; model is the supplied
value when the `model` key is present (including null or empty values), and the
adapter virtual model only when the key is absent. R initial_status uses
`model=body.get("model", self._model_name)`, not Python `or`. Updates preserve other fields and the original
creation timestamp. `last_event` appears when an event sets it. Completion adds
`output` and `usage` with `input_tokens`, `output_tokens`, `total_tokens`; failure
adds `error`; approval state can add `approval`; completion can include
`pending_steer`. Do not synthesize these optional fields in every state.
[Sources R `_set_run_status`, execution completion, `_handle_get_run`.]

Public states observed in source are `queued`, `running`, `waiting_for_approval`,
`stopping`, `completed`, `failed`, `cancelled`, and `interrupted`. Only the latter
four are terminal for durable replay. The mock can script observations without
implementing tools, approval resolution, SSE, steering, or agent execution.

## Errors and overload

A `_openai_error` normally yields
`{"error":{"message":"…","type":"invalid_request_error","param":null,"code":null}}`.
Codes/types below replace the null/default values. Messages are upstream templates,
not examples containing real user input. [A lines1224–1234; R handlers.]

| Trigger | HTTP | Message | Code/type or headers |
| --- | --- | --- | --- |
| JSON parse failure | 400 | `Invalid JSON` | Default envelope |
| Falsy/missing input | 400 | `Missing 'input' field` | Default envelope |
| No truthy final input content | 400 | `No user message found in input` | Default envelope |
| Invalid truthy history type | 400 | `'conversation_history' must be an array of message objects` | Default envelope |
| Invalid history item at index i | 400 | `conversation_history[i] must have 'role' and 'content' fields` | Substitute decimal index |
| Invalid nonempty idempotency key | 400 | `Idempotency-Key must be 1-255 visible ASCII characters` | `invalid_idempotency_key` |
| Same scoped key, different fingerprint | 409 | `Idempotency-Key was already used with a different request payload` | `idempotency_key_conflict` |
| Missing or inaccessible run | 404 | `Run not found: <run_id>` | `run_not_found`; GET and stop |
| Nonterminal run owned by another live process, no local worker | 409 | `Run is not active in this gateway process: <run_id>` | `run_not_active`; stop |
| Capacity exhausted | 429 | `Too many concurrent runs (max <limit>)` | type `rate_limit_error`, code `rate_limit_exceeded`, `Retry-After: 1` |
| Gateway draining | 503 | `Gateway is draining existing work; retry shortly.` | `gateway_draining`, `Retry-After: 1` |

A capacity limit of zero disables the limit; transport-buffer expiry does not
release a live worker's capacity. Configured auth/profile validation and room grants
have additional errors outside this synthetic peer contract; no real authorization
implementation or credentials are required. Request-size middleware has separate
400/413 behavior; the 10,000,000-byte configured bound is source evidence, not a
claim of verified transport parity.

## Fingerprint, replay and identity

`Idempotency-Key` is trimmed first. An absent or whitespace-only header disables
idempotency. A remaining value longer than255 characters or containing code points
outside33–126 fails400. Do not reject whitespace-only values as nonempty invalid
keys after trimming. [R lines452–480.]

The fingerprint is SHA-256 of UTF-8 Python `json.dumps` of
`{"body": normalized_body, "gateway_session_key": validated_key_or_empty_string}`,
with `sort_keys=True`, `separators=(",", ":")`, `ensure_ascii=False`. It includes
the entire normalized body, including unknown fields, not merely input text.
Object-key order is immaterial; array order, changed fields and memory key matter.
Changing `session_id` changes the fingerprint rather than granting a fresh key
namespace. Matching Python serialization requires explicit numeric/unicode test
vectors before claiming fidelity: JavaScript JSON serialization alone does not
preserve Python distinctions such as parsed integer1 versus float1.0.

For ordinary API calls the ownership/replay scope is SHA-256 of
`profile + NUL + configured_identity`; profile defaults to `default`, identity is
the expected configured API key or the literal unauthenticated-listener fallback.
It is not derived from arbitrary supplied bearer text. Hosted-room requests use a
separate verified-claims scope (room/install/authority epoch/member/target/profile);
room token generation and validation are excluded. The mock must model isolation
using explicit synthetic profile/identity controls, without persisting credentials
or changing consumer authorization. [R `_run_idempotency_scope`.]

`X-Hermes-Session-Key` is a distinct long-term-memory scope. A strips it, treats
empty as absent, caps it at256 characters and rejects CR/LF/NUL. In the real
adapter a nonempty key without configured API-key support gets403. The two header
validation400 errors have only `message` and `type`, omitting `param` and `code`:
`Invalid session key` or `Session key too long`. These facts must not become an
unsolicited auth implementation in Mockingbird. The pinned run handler passes the
memory key to the agent but does not derive `session_id` from it; the current-main
Context7 excerpt does. [A `_parse_session_key_header`; R lines546–607.]

Replay returns HTTP202 with the original `run_id`, current stored `status`, and
`replayed: true`; header `Idempotency-Replayed: true`, plus the memory-key echo if
present. This applies to terminal as well as in-flight retained runs. A unique
(scope,key) reservation and unique run ID enforce one admission for concurrent
identical submissions. Conflict reserves no replacement. Requests with no key
always create a new run. There is no public idempotency lookup endpoint.
[Sources R replay/reservation branches; I `lookup`/`reserve`; T replay/scope tests.]

Peer-run ID is the public lifecycle identity. Session ID is conversation context;
memory key is long-term memory context; idempotency key is a scoped admission key.
Kanban attempt IDs and client intake IDs are external identities, never substitutes
for a public run ID. No Kanban or Initiative behavior is inferred from these routes.

## Stop, completion and logical restart

`POST /v1/runs/{run_id}/stop` returns HTTP200
`{"run_id":"run_<opaque>","status":"stopping"}` for active work. It updates
stored state to `stopping`/`last_event: "run.stopping"` and requests interruption;
it does not synchronously declare completion or remove worker handles. Repeated
stop on still-active work follows the same branch. A terminal run returns its
whole stored status object with HTTP200; it is not rewritten to cancelled.
A missing run returns404; a retained nonterminal run without a local agent/task
returns409 as above. [R lines1353–1422.]

When a stopped executor returns `interrupted: true`, status becomes `cancelled`.
If completion wins and returns a normal final result, it becomes `completed`,
even after a stop request. Structured execution failure remains `failed`.
Stopping queued work before agent creation also ends as cancelled. The mock must
script these distinct outcomes and preserve pending work between acceptance and
settlement. [R lines705–719 and858–927; T
`test_completion_wins_before_uncooperative_stop_is_acknowledged`.]

Only keyed runs are persisted in I. On cache miss, R hydrates durable status in
scope. A nonterminal record whose owner PID/process-start identity is no longer
alive becomes `interrupted`, with `error: "The gateway restarted before this run settled."`,
`last_event: "run.interrupted"`, and an updated timestamp; the changed status is
persisted. Terminal records remain terminal. A still-live owner is not falsely
interrupted; stop from another process may therefore return409. Keyless records
are in-memory and unavailable after real adapter replacement. Durable storage can
fall back to memory, explicitly losing restart durability. Model restart as a
synthetic control, not an assertion of actual process/disk persistence.
[R `_durable_run_status`; I constructor; T restart/hydration tests.]

## Retention and exact boundaries

There are separate lifetimes, not a single run TTL. [A lines7507–7508;
R lines1425–1474; I `_prune_stale_terminal_locked`, `status_for_run`, `update_status`.]

| State | Rule in pinned source |
| --- | --- |
| Unsubscribed SSE buffer | Sweep when age is strictly greater than300seconds; active execution/control survives |
| Cached completed/failed/cancelled status | Sweep when now minus `updated_at` is strictly greater than3600seconds |
| Cached interrupted status | Omitted from this in-memory sweep's terminal set; do not silently add it |
| Ordinary durable keyed terminal reservation | Prune when stored DB `updated_at` is strictly less than now minus86400seconds; equality retains it |
| Durable nonterminal reservation | Never prune solely because of age |
| Room retention horizon | Terminal pruning at now greater than or equal to positive `retention_until` |
| Acknowledged room receipt | Terminal pruning at acknowledged time less than or equal to now minus86400seconds |

The periodic memory sweep runs every60seconds. Durable pruning is lazy in
`lookup`/`reserve`; `status_for_run` and ownership lookup do not prune. Thus a GET
after24hours is not automatically404: it may return cache or hydrate a still-stored
row until admission triggers pruning. A pruned row can also coexist temporarily
with cached status. After both applicable stores no longer contain the run, GET
returns the normal `run_not_found`404; never invent an `expired` execution status.
After expiry releases a reservation, the same key can admit a new run.

Status changes and terminal/payload updates persist; repeated progress events
with unchanged execution status may update the memory timestamp without refreshing
the database timestamp. Preserve these clocks independently for exact retention
claims. Room horizon/acknowledgment operations are documented only as boundaries
of the ordinary peer subset, not as promised new room endpoints.

## Reconciliation, implementation gates and remaining gaps

- Documentation's concise new-run example omits `replayed`; pinned source includes
  it. Use source envelopes. Documentation's general24hour statement omits active
  reservations, lazy pruning, cached status and room exceptions; use the rules above.
- Current documentation describes stopping as ending in cancelled. Pinned source
  and its completion-race test also allow completed or failed. Preserve that race.
- Current-main session-key-to-conversation resolution is not in this pinned handler.
  Do not import it as a silent upgrade. Pinned `input` handling also differs from
  other API families; do not copy Responses API validation wholesale.
- Later implementation must characterize Python fingerprint serialization with
  synthetic numeric/unicode vectors, exact retention equality and trigger points,
  cached-versus-durable lifetime, replay at capacity, stop races, and restart of
  keyed versus keyless records. No caller recovery/intake policy is implied.
- Arbitrary malformed roots/elements, model-routing/transcript resolution,
  hosted-room grants, SSE/approval/steer execution, provider credential errors,
  and HTTP middleware edge cases are not independently verified. They block
  corresponding compatibility claims; they do not authorize invented envelopes.
- No pinned runtime/oracle has run. US-022 must verify the required lifecycle,
  replay/conflict/stop/restart/retention behavior with a scripted execution boundary
  and disposable storage before any real-runtime parity claim. Dependency installs,
  database migrations/cleanup and service lifecycle still require applicable approval.
- This evidence establishes the research contract for US-015, not delivery of
  US-016–023 or Ready status. No credentials, real prompts or customer data were used.

## US-017 implementation refresh (2026-09-27)

Resolved `/nousresearch/hermes-agent` again and queried submission/polling fields
and validation. Context7 still lacks `v2026.8.31`; results cite current-main run
handlers and programmatic-integration documentation. Its newer terminal flags
(`completed`, `partial`, `turn_exit_reason`) and shutdown wording are not imported
into this pinned mock. Re-fetched R at immutable commit
`29112bef099274229cadff79cdff7bf7b99c4b77`; SHA-256 remains
`048ae843592d701ff47437bd8edd47cd64ca6c0fdf88a71045bdb6fb337fbc63`.
Re-read admission, `_set_run_status`, completion/failure and GET branches.

The implemented subset admits keyless ordinary submissions, preserves session/model
metadata, and polls stored public observations. Python JSON truthiness is retained
for input/history validation. Non-object roots and malformed final message elements
return explicit mock-only 501 responses because their upstream error behavior is
not verified. Hosted rooms, nonempty idempotency keys and invalid memory headers
also return explicit 501 responses at this stage. Valid memory keys are echoed;
no credentials are checked or used as namespace identity.

The default virtual model is `hermes-agent` (A `_resolve_model_name` fallback).
Model routing, transcript loading and inference are not executed; history is
validated and discarded with prompt text. Synthetic observation controls are under
`/__admin/hermes/runs/{id}/observe`, never under vendor paths. GET does not advance
state. These controls can script the public states and terminal payloads, without
claiming to execute stop, restart, approval, SSE or steering. Real stop/restart
behavior remains US-019. Terminal observations cannot be revived by this control.
Completion supplies empty output/zero usage unless synthetic values are supplied;
failed/interrupted defaults follow the pinned strings. Leaving approval state
removes its approval field, as in `_set_run_status`. IDs use the shared deterministic
sequence encoded into opaque 32-character hex tokens, not actual random UUIDs.

Package tests establish internal contract consistency only. The pinned runtime
comparison remains US-022.

## US-018 implementation refresh (2026-09-27)

Context7 resolution still lists no target release. Its idempotency query returned
unrelated current-main profile/session material, not an exact pinned fingerprint
contract; no such snippets were promoted to evidence. Re-read R fingerprint,
validation, replay, scope and reservation order, and I lookup/reserve transactions.
Re-fetched I at pinned commit29112bef099274229cadff79cdff7bf7b99c4b77;
SHA256 remains746904b3b6ed45d8359655b2e87c1f101394b13f6253e718ac9a83acd46174f2.

Idempotency now supports ordinary synthetic scopes: SHA256 of profile, NUL and
synthetic listener identity; settings never derive from bearer text. The whole
body plus validated memory-key string is canonicalized and hashed. A local raw
JSON tokenizer retains number lexemes and duplicate-key last-value semantics;
integers retain arbitrary precision, floats use Python exponent thresholds and
integral `.0`, keys sort by Unicode code point. A small local tokenizer was chosen
over changing the shared HTTP decoder or importing an undeclared transitive JSON
library. Fetch and exposed Hono entries both preserve raw bytes as decoded text
until admission. No raw request or canonical prompt text is stored.

The committed `evidence/fingerprint-python.json` has 25 synthetic canonical-byte
and SHA256 vectors generated independently with Python stdlib json/hashlib (Python
version recorded there). Cases cover int/float distinction, negative zeros, large
integers, exponent thresholds, subnormal/maximum/overflow/underflow floats,
BMP/astral sorting, escapes, duplicate keys and prototype-like keys. An additional
seeded corpus of2,000 finite binary64 values matched Python's canonical text with
zero differences. This establishes those tested values, not exhaustive float-space
proof or Hermes runtime parity. Lone surrogate strings are explicit501 because
pinned Python UTF8 encoding cannot fingerprint them. Nonstandard JSON NaN/Infinity
literal tokens and middleware/malformed-root behavior remain outside verified input
claims; standard JSON numeric exponents that overflow are included in vectors.

Scoped lookup/reservation/run creation is one synchronous shared SQLite transaction
after asynchronous hashing. Across concurrent facades, identical submissions create
one run; conflicts preserve the original. Replays use current public status and
retain headers. Python header stripping includes U+0085; JSON syntax errors precede
key validation. The synthetic scope control, owners and reservations participate
in shared reset and Timeline. Terminal replay survives reconstructing the API with
the same backing client/namespace. This is a modeled adapter/storage boundary, not
real process/disk persistence or completed logical-restart semantics: unfinished
restart interruption remainsUS-019 and retention remainsUS-020.

## US-019 stop and logical restart refresh (2026-09-27)

Resolved and queried Context7 for stop/race/restart again. Results remain current
main and advertise no target version; new shutdown flags/text were not substituted
for the pinned source. Refetched R at immutable29112bef099274229cadff79cdff7bf7b99c4b77,
SHA256 still048ae843592d701ff47437bd8edd47cd64ca6c0fdf88a71045bdb6fb337fbc63.
Read R `_handle_stop_run` and `_durable_run_status` plus pinned completion-race and
restart test locations. Stop first checks scoped visibility, returns full terminal
status unchanged, rejects a live foreign owner without local work with409, or
records stopping and returns the two-field acceptance200.

Implemented explicit namespaced logical restart, with stale/alive modeled owner
states. No PID probing, thread, inference, process kill or actual service restart
occurs. Keyless state disappears; keyed records/reservations remain. Stale-owner
nonterminal hydration occurs on poll/replay/stop, preserves creation time and
updates interruption time at that first access. In particular, pinned durable
hydration uses a direct status.update, so a waiting approval payload is retained
on interruption (normal `_set_run_status` would clear it). Terminal records and
repeat interruption reads remain unchanged. A live foreign owner does not become
interrupted and cannot be stopped in this modeled gateway. Admin observations may
script its eventual result. Terminal controls still reject revival.

All unfinished/terminal states, stop acceptance versus cancellation/failure/winning
completion, original-key interrupted replay versus new-key admission, keyless
loss, scopes and shared Timeline ownership restoration are covered by package
tests. Actual pinned runtime comparison remainsUS-022; retention/cache/durable
expiry separation remainsUS-020. These controls do not claim actual process or disk
restart durability.

## US-020 retention evidence

Re-read pinned R lines 1425–1474 and I lines 241–380; refreshed I from commit
`29112bef099274229cadff79cdff7bf7b99c4b77`, retaining SHA256
`746904b3b6ed45d8359655b2e87c1f101394b13f6253e718ac9a83acd46174f2`.
Context7 still did not advertise the target release; unrelated/current-main
results were not used as pinned evidence.

R sweeps every 60 seconds and drops cached completed/failed/cancelled results only
when update age exceeds 3600 seconds. Interrupted results are excluded. I prunes
ordinary terminal rows only on lookup/reserve, with durable updated_at strictly
less than now minus 86400; status lookup does not prune, and active rows do not age
out. Persistence tracks status changes, terminal observations and selected payload
fields separately from cached progress timestamps. Pruning commits before a later
conflict is returned. Hosted-room retention and SSE buffer expiry are excluded.

Tests exercise exact equality and one millisecond beyond, cache recovery from
durable rows, pruning versus cached survivors, active and interrupted states,
progress persistence, restart and Timeline. The mock folds elapsed sweep ticks
into the next admission/observation and offers an explicit single-sweep control;
it does not start a background worker. This source-backed model remains subject
to the independent runtime comparison in US-022.

## US-021 fault evidence

Context7 resolution still lacks v2026.8.31; its general retry/current-main snippets
were not used as pinned envelopes. Pinned A `_draining_response` lines1693–1704
returns503, invalid_request_error/gateway_draining and Retry-After1. Capacity check
lines7190–7208 returns429, rate_limit_error/rate_limit_exceeded and Retry-After1;
the fixture message uses the pinned default limit10. The explicit presets do not
implement automatic capacity accounting or gateway lifecycle.

Response loss and poll delay are Mockingbird transport scenarios, not invented
Hermes error responses. Scripted executor failure uses the existing pinned failed
observation envelope. The native Node consumer uses literal HTTP contracts and no
provider state helpers. Eligible self-parity and deliberate lifecycle divergence
tests exercise the comparator; actual pinned runtime execution remains US-022.

## US-022 executed pinned oracle

The authorized loopback oracle executed the exact pinned run and idempotency
modules, original ancillary auth/redaction/PID helpers and original SQLite
journal-mode helper against a new disposable file-backed database. Its scripted
executor replaced inference; session/approval/tool-process integrations and
routing/capacity were explicitly bounded as documented in [oracle/README.md](oracle/README.md).
No credential-enforcement claim is made.

[Recorded report](evidence/pinned-oracle.json):33 public HTTP comparisons passed
with Python3.11.16, aiohttp3.14.3 and SQLite3.53.1, WAL in both distinct process
epochs. Evidence covers replay/conflict, stop/cancel/completion race/failure,
terminal/unfinished/keyless actual process restart, interrupted replay, exact
one-hour cache and24-hour durable boundaries, GET without durable pruning,
expiry/re-admission and404 after pruning plus sweep. This establishes that matrix,
not inference, hosted rooms, whole-gateway startup, production auth, automatic
capacity, power-loss durability or arbitrary malformed-input compatibility.
