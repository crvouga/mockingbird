# GitHub REST contract evidence

Research date: 2026-09-27. This is the US-024 contract definition, not implemented
support or live parity evidence. Delivery remains independent of Initiative.

## Version and reproducible source

Target `https://api.github.com` with `Accept: application/vnd.github+json` and
**`X-GitHub-Api-Version: 2026-03-10`**. GitHub's [version policy](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
lists that version as supported and identifies `2022-11-28` as the current default
when the header is omitted. The mock must explicitly advertise its selected
version; accepting an omitted header must not claim compatibility with the older
contract. Unsupported-version handling must be documented as a mock limitation
unless compared with GitHub.

The authoritative schema is the stable, version-specific file
[`descriptions/api.github.com/api.github.com.2026-03-10.json`](https://github.com/github/rest-api-description/blob/c6721f32a17a71397ae46be21be90d7f1a173b6e/descriptions/api.github.com/api.github.com.2026-03-10.json),
not `descriptions-next` or an unversioned alias:

- Repository: `github/rest-api-description` (MIT).
- Commit: `c6721f32a17a71397ae46be21be90d7f1a173b6e`.
- File SHA-256: `106b151eb723284d9449cd6dae26bc87e60d313f75e8ad98c18e9327d4281b88`.
- OpenAPI metadata version `1.1.4` describes the specification; it is not the API date.
- [Raw immutable source](https://raw.githubusercontent.com/github/rest-api-description/c6721f32a17a71397ae46be21be90d7f1a173b6e/descriptions/api.github.com/api.github.com.2026-03-10.json).

Context7 resolved `GitHub REST API` to `/websites/github_en_rest`; also advertised
`/github/rest-api-description` and generated OpenAPI indexes. Queries covered
repository identity/default branch, matching/get/create/update refs, ancestry and
force, PR create/get/list/update, filters/pagination, errors and idempotency.
Its answers confirmed ref and PR-list routes but did not establish a pinned API
version, duplicate-PR wire errors or universal idempotency. The explicit immutable
schema above, read directly, resolves versioned field/status definitions. Context7's
permission summaries are not authorization evidence and are not modeled as policy.

## Declared operation inventory

These nine operations define the initial REST subset. Schema-listed statuses are
an inventory, not a promise to implement every response or deployment condition.
Unsupported paths and features must be explicit in the eventual support matrix.

| Operation ID | Method and path under `/repos/{owner}/{repo}` | Schema statuses |
| --- | --- | --- |
| `repos/get` | `GET` repository root | 200, 301, 403, 404 |
| `git/get-ref` | `GET /git/ref/{ref}` | 200, 404, 409 |
| `git/list-matching-refs` | `GET /git/matching-refs/{ref}` | 200, 409 |
| `git/create-ref` | `POST /git/refs` | 201, 409, 422 |
| `git/update-ref` | `PATCH /git/refs/{ref}` | 200, 409, 422 |
| `pulls/list` | `GET /pulls` | 200, 304, 422 |
| `pulls/create` | `POST /pulls` | 201, 403, 422 |
| `pulls/get` | `GET /pulls/{pull_number}` | 200, 304, 404, 406, 422, 500, 503 |
| `pulls/update` | `PATCH /pulls/{pull_number}` | 200, 403, 422 |

Primary references: [repositories](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[refs](https://docs.github.com/en/rest/git/refs), [pull requests](https://docs.github.com/en/rest/pulls/pulls).
The schema is exhaustive for this table; common HTTP/auth/rate errors can exist
beyond an operation's listed responses and need corresponding mock contract entries
when explicitly scripted.

## Identity, state and scope

Repository `id` and opaque `node_id` are distinct from `owner.login`, `name`,
`full_name`, URLs and `default_branch`. Owner/repository lookup is case-insensitive
per shared schema parameters; do not infer that Git ref names are case-insensitive.
A default branch is a branch name, not a commit ID. Ref responses use a full `ref`
(such as `refs/heads/topic`), opaque `node_id`, URL and `object` containing type,
SHA and URL. Preserve nested branch names. A PR has its own ID, opaque node ID,
repository-scoped integer `number`, URLs, and separate head/base branch/repository/
SHA relationships. Do not identify PRs solely by a mutable branch tip.

Mock namespaces isolate all synthetic repository, commit ancestry, ref and PR
records. Explicit admin seeding creates synthetic commit objects/parent edges;
this is not Git object storage, commit creation over REST, push, clone or fetch.
Shared Collections, injected clock, deterministic IDs and Timeline own persistence
and history. No token issuance, GitHub App identity or production authorization
logic is introduced. Scripted denied responses are scenarios, not verified
permissions, branch protection or repository rules enforcement.

## Reference semantics and concurrency

The single-ref read uses `/git/ref/{ref}`; mutations use `/git/refs`. Matching-ref
reads return prefix matches, so a missing exact branch can still have matching
longer names. The source also documents the empty prefix as all refs. It declares
no `page` or `per_page` parameters for this endpoint; do not invent PR-style
pagination for matching refs. A missing exact ref returns 404.

Creation requires a fully qualified `ref` and `sha`; GitHub documents rejection
without `refs` and at least two slashes, and disallows ref creation in an empty
repository without branches. Validation and collisions must not overwrite an
existing ref. Exact error wording for collisions, missing objects, malformed names
and empty repositories still needs the authorized oracle; listed 409/422 statuses
alone do not prove which condition uses which envelope.

Update requires `sha`, with optional `force` defaulting to false. Non-forced
updates require a fast-forward from the head current when the request executes.
The mock must evaluate seeded ancestry at mutation time, including intervening
head movement. It may model force on synthetic records or explicitly reject it
as unsupported; no live force-push is authorized.

**REST ref update has no documented expected-old-SHA request field.** This follows
from the pinned update schema's complete property list (`sha`, `force`), not a
claim that every GitHub transport lacks compare-and-swap. Fast-forward checking
is not an expected-head lease: a concurrent update can still permit a later update
if ancestry allows it. Do not add fictional `expected_sha`, `old_sha`, operation-ID
or atomic ref-plus-PR guarantees. Initiative's broker/transport selection and
publication lineage remain consumer responsibilities.

## Pull requests and uncertain creation

Create accepts `head`, `base`, and a title unless converting an existing `issue`;
optional fields include body, draft, maintainer modification and cross-repository
head metadata. The base belongs to the target repository; head syntax may carry
an owner prefix. Update accepts title, body, state (`open`/`closed`), base and
maintainer modification; it does not replace the head branch. The initial mock
must preserve supported repository/head/base/number/SHA relationships and explicitly
mark issue conversion, cross-repository networks or unsupported media/features
rather than silently claiming them. Mergeability computation and test merge
commits are outside the initial subset; null is not proof of a clean merge.

**The pinned PR-create schema documents no universal idempotency-key contract.**
No header or body property in this operation promises consumer operation-ID
replay. Retrying after a lost response requires observing remote state, including
head/base filters and pagination; a duplicate validation error is not a replay
response. Exact duplicate/no-change-branch errors and closed-PR re-creation cases
are not established by the generic 422 declaration. US-027/US-030 must obtain
specific evidence before claiming exact duplicate compatibility; never invent
server-side request-ID deduplication to make the consumer fixture pass.

PR creation can trigger notifications and secondary rate limits. Live creation
requires explicit disposable repository, write and notification authorization.
No external PR/ref has been created during this research.

## Pagination and errors

PR lists default to state `open`, support `open`/`closed`/`all`, head in
`owner:branch` form, and base branch filters. The schema declares sort values
`created`, `updated`, `popularity`, `long-running`; default created order is
descending, while the other default directions are ascending. Support each
advertised option accurately or report it as unsupported. Page defaults to 1;
per-page defaults to 30, maximum 100. The [pagination guide](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
documents clamping oversized per-page requests, omission of Link when unnecessary,
and navigation via available next/prev/first/last relations. Filter first, then
sort/page; retain filters in generated links. Do not infer a consistent snapshot
across concurrent list calls. Invalid negative/noninteger query handling remains
a targeted oracle question.

Pinned `basic-error` fields include message, documentation_url, url and string
status. Validation errors require message/documentation_url and can add structured
errors (resource, field, code, message) or strings via the simple variant. Do not
force every provider failure into one shape. Missing/private resources may be
indistinguishable to a client; the mock's scripted 404/403 scenarios do not prove
real authorization behavior. See [troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

The [rate-limit guide](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
distinguishes primary/secondary limits; exhaustion can return 403 or 429. Honor
Retry-After when present and expose appropriate x-ratelimit metadata in scenarios.
Do not simulate real quota consumption, identity-based limits or enforcement.
Accepted-write/response-loss must retain state independently of transport failure;
pre-mutation errors must leave state unchanged and journals must remain metadata-only.

## Verification gaps and next gates

This story ran read-only documentation/schema retrieval and source validation.
No account, credential, operational repository, writes or notifications were used.
No runtime compatibility, full schema coverage or Ready status is claimed.

Subsequent work must resolve exact semantic wire errors through primary evidence
or bounded authorized live comparisons, preserve operation coverage and deliberate
divergence sensitivity, and exercise lost PR acknowledgment, ref movement,
duplicates, pagination and retry-after with an independent consumer. US-030 needs
an explicit owned disposable repository and operations/cleanup scope; missing
credentials must be reported by key name only. No default-branch update, merge,
force-push or unrelated resource modification is allowed. All provider limitations
must remain visible in SUPPORT/README and the oracle report.

## US-026 reference implementation evidence

Refreshed Context7 `/websites/github_en_rest` and official GitHub refs documentation
on 2026-09-27 against the same pinned schema. Get is exact, list is prefix-based
(including an omitted prefix), create requires a qualified name and a nonempty
repository, and update accepts SHA plus optional force. The commit graph is synthetic;
non-forced writes check the current head inside the write transaction. An ignored
unknown `expected_sha` field cannot create an expected-head lease.

Ref naming follows the [Git reference format rules](https://git-scm.com/docs/git-check-ref-format)
for slash components, forbidden punctuation/control characters, `..`, `@{`, trailing
dots and `.lock`. These rules are implemented locally, without invoking Git.
Only seeded commit objects are modeled; annotated tags and provider-managed pull
refs are not implemented. Force rewrites synthetic records only.

Current errors use a documented provisional profile: missing repository/read ref
404; creation in an empty repository409; duplicate or directory-name collision,
missing target object/update ref, malformed input and non-fast-forward update422.
Bodies contain message, documentation_url and string status. Exact condition/status
mapping, validation precedence and messages are not live-verified against the pinned
API. The schema's generic409/422 inventory alone does not establish these details;
US-030 must compare and correct the provisional profile before claiming live parity.
No real GitHub writes or notifications occurred during this implementation.

Hono's [slash-bearing parameter documentation](https://hono.dev/docs/api/routing)
and installed4.11.9 behavior support an explicit terminal-tail route. Shared core
compiles dispatch and journal/fault matching from the same opt-in metadata. Ordinary
parameters retain single-segment routing; only list-matching-refs allows empty tail.

## US-027 pull-request implementation evidence

Context7 `/websites/github_en_rest` was refreshed for PR create/get/list/update,
filters and pagination; request fields were checked directly against the pinned
2026-03-10 schema. The unrelated update-branch operation has an expected_head_sha
field; that is not the ref-update endpoint and is not part of this contract.

Duplicate creation is grounded in first-hand public API error reports:
[Renovate discussion19913](https://github.com/renovatebot/renovate/discussions/19913)
contains a POST /pulls422 response, message Validation Failed, and an errors item
with resource PullRequest, code custom, and a message identifying the existing
owner-qualified head with a final period. [Release Please issue2773](https://github.com/googleapis/release-please/issues/2773)
reports the same duplicate-create failure after lookup misses an existing PR in
May2026. These are original incident observations, not a versioned GitHub guarantee;
no real names or repository data from those reports are copied into fixtures.
They establish the modeled duplicate shape, not all validation precedence or
closed/reopened/cross-repository cases. US030 still needs the selected-version oracle.

Same-repository PR identity and mutable title/body/state/base flags are stored in
shared Collections with a separate per-repository number sequence. Open read/list
responses project current branch-tip SHAs. Closed records retain captured tips until
explicitly updated; timestamp/event propagation, tree/content differences, merge-base
computation and actual mergeability are not claimed. Synthetic ancestry with head
reachable from base cannot create a PR. Other validation envelopes and closed PR
recreation/reopening behavior remain provisional until compared.

Supported list filters are applied before sorting/paging. Default page1/per_page30,
cap100 and Link navigation follow the pinned fields and pagination guide. Popularity
and long-running sorts, issue conversion, cross-repository networks and non-JSON
bodies are explicit limitations. Negative/noninteger pagination validation is a
synthetic422 profile pending oracle evidence. Namespace pagination is rewritten at
the GitHub runtime response boundary using the original public header/path carrier;
physical Timeline storage namespaces are never exposed in links.

The lost-ack test drops the caller's received response after a successful local
create, then independently lists and gets the PR. It proves recoverable stored state,
not a real network failure or live GitHub retry guarantee. Shared accepted-write
transport-drop presets are the next story. No real PRs, notifications, credentials
or external mutations were used here.

## US-028 scripted publication faults

Read on2026-09-28: GitHub's official
[rate-limit guide](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [troubleshooting guide](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
document primary/secondary failures as403 or429, primary remaining0, and waiting
for Retry-After when supplied. They identify integration-denied errors as a
permissions symptom. These sources support the response categories, not an exact
universal envelope or the fixture's chosen remaining1/Retry-After60 values.
The presets deliberately script secondary429, denied403 and unavailable503
observations. No real credentials, permissions, protection rules, quotas or outages
are evaluated; exact fault fixture wording is not pinned live parity evidence.

Accepted-drop scenarios reuse shared acceptance/checkpoint and socket-drop handling;
tests compare accepted state, metadata-only journal and restored history for all four
write operations. A local loopback HTTP test verifies PR discovery after the Node
adapter closes the response connection. This is local transport evidence, not a
claim about GitHub's network. Ref movement uses a separate mock-only admin checkpoint
and seeded fast-forward ancestry; no expected-old-SHA lease is introduced.

## US-029 local parity and independent consumer evidence

The parity runner now plans/exercises all nine implemented operations against
isolated seeded mocks, with fixed-clock fixtures. Separate constrained walks
require successful statuses and meaningful repository/ref/PR fields per operation;
missing-repository404 equivalence cannot satisfy these checks. A schema-valid
private-field divergence in a successful repository response is rejected with
ParityError/mismatch, and the test verifies the divergent response was compared.
Only the four mutation operations are marked parity unsafe.

An independently written Mockingbird-owned Node HTTP consumer imports the compiled
server for lifecycle, while all fixture control and consumer requests use literal
HTTP contracts. It exercises socket-loss lookup, duplicate422, same-key distinct
creates, default-page pagination across31PRs, an intervening ref update, acceptance
of a fast-forward despite a stale ignored expected_sha field, and Retry-After
scheduling with logical time. No Initiative broker, real Git transport, live
provider permission checks or remote notifications are involved. These local
checks establish harness sensitivity and consumer interoperability, not live parity.

## US-030 bounded live oracle, 2026-09-29

An explicitly authorized run in a private disposable repository selected API
2026-03-10, confirmed by GitHub's response header. Run
`f01cada4-47b9-47b0-8c74-dbe4eddc76bc` used 26 requests and compared all nine
supported operations. Eleven of twelve projected comparisons matched, including
repository identity, ref creation/read/list/fast-forward, non-fast-forward422,
PR creation/duplicate422/get/list. The PR update returned200 on both sides but
did not match: clearing its body with an empty string produces null on GitHub.
A subsequent read of the closed fixture PR confirmed null. The mock now converts
an empty update body to null; a regression failed before the repair and passed
afterward, covering update/get/list and subsequent omitted-body edits.

Cleanup closed the acknowledged PR and deleted both unchanged acknowledged refs.
Read-only reconciliation found only main at its original SHA. No uncertain writes
were recorded. The closed PR and Git objects remain. The original report retains
`complete: false`; it is not overwritten or reclassified after the local fix.
A separately approved run `87b2f906-12fa-4f92-a373-09b7c4d85a21` then matched
all 12 comparisons across the nine operations, including the repaired body update.
It used26requests, closed its PR and deleted both owned refs, with no failures or
uncertain writes. Read-only reconciliation again confirmed only unchanged main.
Both local reports retain their actual outcomes independently.

The checkout-only [oracle instructions](https://github.com/crvouga/mockingbird/tree/main/packages/service/github/oracle) document exact manifests,
ownership receipts, explicit notifications/cleanup grants, credential handling,
request limits and conservative uncertain-write cleanup. Compared projections do
not establish full response-schema parity, validation precedence, multi-page live
pagination, real access control, rulesets, rate quotas or network-loss guarantees.
