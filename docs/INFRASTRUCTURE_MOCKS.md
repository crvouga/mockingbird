# Infrastructure and orchestration mocks

This document defines the boundaries and planned evidence for the Docker Engine,
Hermes peer-run, and GitHub REST packages.

It implements
[US-001 of the requirements](../tasks/prd-infrastructure-orchestration-mocks.md#us-001-define-package-boundaries-and-scenario-ownership).
The [archived plan](../tasks/archive/infrastructure-orchestration-mocks/PLAN.md) records delivery order: Docker, then Hermes, then GitHub.
The scenarios below are requirements, not claims of implemented or verified support.
Each package starts as `wip`; its eventual contract, generated support matrix, and
versioned `API_EVIDENCE.md` will define the supported subset.

## Package boundaries

| Planned package | Public provider behavior | Explicit exclusions |
| --- | --- | --- |
| `@crvouga/mockingbird-service-docker` | Engine discovery, container observations and lifecycle, retained HTTP, Unix sockets, non-TTY attach upgrade and streams | Container execution, builds, host isolation, cgroup enforcement, socket/process provenance; exec, logs, events and TTY modes outside the researched subset |
| `@crvouga/mockingbird-service-hermes` | Pinned public peer-run submission, polling, stopping, fingerprinting, scoped replay, interruption and retention | Agent execution, inference, Python dispatcher compatibility, Kanban attempts, consumer intake policy and credential enforcement |
| `@crvouga/mockingbird-service-github` | Repository observations, references over seeded commits/ancestry, PR operations, pagination and uncertain-write observations | Git transport, App token issuance, real authorization or branch-rule enforcement, consumer publication journals and invented atomicity/idempotency guarantees |

Docker API v1.52 attach paths and unversioned `/info` are observed consumer inputs,
not proof of an installed Engine version. US-002 must reconcile them with the
versioned specification and select an explicit oracle. Hermes targets
`v2026.8.31`; current-main documentation does not establish that tag's behavior.
US-024 must select the GitHub API header version and OpenAPI revision. No new
provider behavior is specified from memory in this boundary document.

All packages use the standard health, reset, namespace, clock, fault, metrics and
metadata-only journal controls described in
[Authoring a service](AUTHORING_A_SERVICE.md#the-service-contract-what-crvougamockingbird-service-gives-you).
Scenario controls belong to Mockingbird admin/runtime interfaces; they must not
masquerade as vendor endpoints. Synthetic identity scopes and scripted denied
responses are observations for tests and do not implement authentication policy.
Fixtures contain generic synthetic data, never real customers, credentials,
prompts or results in the journal.

## Evidence classes and scenario IDs

Each row has one primary class. Tests may connect rows across classes, but must
report their evidence separately.

| Class | What it establishes | What it cannot establish |
| --- | --- | --- |
| `portable` | Deterministic Fetch/runtime state and contract behavior in the mock, including independent local HTTP consumers where applicable | Vendor fidelity from self-parity alone; OS or process guarantees |
| `socket` | Node transport behavior through a package-owned raw HTTP/Unix-socket/attach consumer | Host provenance, confinement, or a real daemon's restart behavior |
| `oracle` | Recorded comparisons with the explicit real provider/version and authorized disposable resources | Operations, versions or failure modes not actually exercised |
| `external-consumer` | Evidence owned by the consuming application or native host | A Mockingbird delivery dependency or a guarantee supplied by a fixture |

Scenario IDs are stable references for future tests and evidence records. The story
column points to the required implementation/verification owner; it is not an
assertion that the story has passed.

### Shared and Docker scenarios

| ID | Class | Required observation | Stories |
| --- | --- | --- | --- |
| SH-01 | portable | Standard controls, namespace/reset isolation, redacted journal and shared Timeline coordination | US-003, US-016, US-025 |
| SH-02 | portable | Checkpoint/checkout restores durable records, logical clock and relevant deterministic state; no provider-local history manager | US-005, US-008, US-020, US-028 |
| DK-01 | portable | Engine discovery/info and seeded image/container inspection/listing; immutable identity distinct from lifecycle and daemon availability | US-004 |
| DK-02 | portable | Create/inspect consistency, launch metadata, missing-image errors and concurrent name conflicts | US-005 |
| DK-03 | portable | Start/wait contract, repeated calls, scripted completion/exit code, cancellation of pending waiters | US-006 |
| DK-04 | portable | Stop/kill/removal checks, delayed termination, removal conflicts; accepted stop is distinct from completed termination | US-007 |
| DK-05 | portable | Pre-mutation failure versus accepted mutation with response loss; state, journal and history remain coherent | US-008 |
| DK-06 | portable | Logical daemon unavailability/restart explicitly preserves or terminates modeled execution; loss of observation alone does not retire it | US-008 |
| DK-07 | socket | Owned Unix socket and TCP serving, retained sequential HTTP, bounded requests, deliberate disconnect and refusal of unowned socket paths | US-009 |
| DK-08 | socket | Supported versioned attach query and 101 handshake, fragmented headers, first stream bytes, missing/unsupported/aborted handshakes | US-010 |
| DK-09 | socket | Non-TTY multiplexed stdout/stderr and supported stdin, split frames, backpressure, EOF, cancellation and execution surviving disconnect | US-011 |
| DK-10 | socket | Reset/checkout/shutdown invalidate live streams and waiters; stale streams never emit restored or successor output; handles are not snapshotted | US-009, US-011 |
| DK-11 | portable | Eligible self-parity covers every declared operation and detects intentional divergence; pinned SDK coverage where applicable | US-012 |
| DK-12 | socket | Independent retained-HTTP/attach consumer observes accepted mutation, lost reply and subsequent inspection without importing Initiative | US-012 |
| DK-13 | oracle | Lifecycle and attach comparisons with explicit Engine endpoint/version, owned resources and scoped cleanup | US-013 |
| DK-14 | oracle | Separately authorized real restart/live-restore observations, if claimed; transport-fault tests never stand in for these | US-013 |

### Hermes and GitHub scenarios

| ID | Class | Required observation | Stories |
| --- | --- | --- | --- |
| HM-01 | portable | Scripted submit/poll lifecycle, opaque run IDs, required fields and pinned missing/error envelopes | US-017 |
| HM-02 | portable | Exact pinned fingerprint/synthetic profile-session scope; identical and concurrent replay yields one run, conflicting reuse fails | US-018 |
| HM-03 | portable | Pinned stop acceptance/intermediate/completion states; logical restart interruption; old-key replay does not revive a run | US-019 |
| HM-04 | portable | Controlled-clock result/deduplication expiry at exact boundaries and coherent history restoration; logical restart is not process-crash durability | US-020 |
| HM-05 | portable | Accepted-run/response-loss, timeout, throttle and scripted errors retain the required state/journal/history | US-021 |
| HM-06 | portable | Independent HTTP submit/poll/stop/replay/expiry consumer plus self-parity coverage and deliberate divergence detection | US-021 |
| HM-07 | oracle | Pinned lifecycle/storage/idempotency code with disposable state and a documented deterministic non-inference executor; replay/conflict/stop/restart/retention comparisons | US-022 |
| GH-01 | portable | Repository/default-branch identity and missing resources; explicit synthetic commit and ancestry seeding | US-025 |
| GH-02 | portable | Ref read/list/create/update, missing objects, conflicts, non-fast-forward errors and intervening head movement over seeded ancestry | US-026 |
| GH-03 | portable | PR create/get/list/update, repository/head/base/number/SHA relationships, filters, pagination and actual duplicate errors | US-027 |
| GH-04 | portable | Pre-mutation failure versus accepted-write/response-loss, rate-limit headers and scripted denial; coherent state/journal/history | US-028 |
| GH-05 | portable | Independent consumer reconciles lost PR replies, duplicates, ref movement, pagination and retry-after; self-parity coverage detects intentional divergence | US-029 |
| GH-06 | oracle | Explicit disposable repository/API version/operation subset, bounded authorized writes and actual recorded comparisons | US-030 |

GitHub fixtures must not introduce an expected-old-SHA field on ordinary REST ref
updates or universal server-side PR deduplication for consumer operation IDs.
Force-update behavior must be modeled faithfully or explicitly unsupported;
live comparisons never force-push. Hermes peer-run IDs, Kanban attempt IDs and
consumer intake IDs remain separate identities.

### External consumer and host evidence

These requirements belong to the
[separate Initiative handoff](../tasks/avengers-initiative-mock-integration-handoff.md).
No edits, execution or test results in Initiative are needed to complete US-001
or any other Mockingbird story.

| ID | Class | External responsibility | Handoff |
| --- | --- | --- | --- |
| EXT-01 | external-consumer | Dispatcher callback retry/accounting, admission, one-writer reconciliation and maintenance fencing | AI-002–AI-004, AI-011 |
| EXT-02 | external-consumer | Actual adapter adoption and retained-session policy; durable intake and delivery-attempt reconciliation | AI-006, AI-007 |
| EXT-03 | external-consumer | UID/socket/procfs/PID provenance, cgroups, mounts, resource/network confinement and actual descendant retirement | AI-005, AI-012 |
| EXT-04 | external-consumer | Selected expected-target publication guard, real Git transport, approval lineage and publication journal recovery | AI-008, AI-009 |
| EXT-05 | external-consumer | Actual App identity and repository-rule denial evidence | AI-010 |
| EXT-06 | external-consumer | Real SQLite WAL/locking/concurrent-process/backup/crash recovery guarantees | AI-013 |
| EXT-07 | external-consumer | Future systemd package assessment after consumer and native-host evidence | AI-014 |

## Code-improvement hypotheses

These are bounded investigation targets, not findings or authorization for shared
refactors. Source observations below were inspected for US-001; they do not replace
the sensitive regressions required by later stories.

| Hypothesis | Existing source and observation | Required evidence before a change |
| --- | --- | --- |
| Accepted mutations may need explicit history capture when response delivery fails | [Runtime](../packages/service/core/src/runtime.ts): ordinary drop faults occur before dispatch; automatic Timeline capture follows a resolved successful mutating response | US-008 must demonstrate post-mutation loss with state, journal and checkout assertions, plus pre-mutation/unrelated-error controls. Only a demonstrated gap justifies a compatible shared fix; no blanket commit-on-error rule or local rollback/history coordinator. |
| Transport lifetime needs package-specific ownership | [Node serving adapter](../packages/adapters/node/src/serve.ts) streams responses and propagates close cancellation, but exposes port/host serving and no attach upgrade path | US-009–US-011 must prove owned path/connection cleanup, failed handshakes, backpressure, cancellation and invalidation across reset/history changes. Keep Docker protocol code local until another concrete consumer justifies sharing. |
| Observable replay state must participate in existing history | [Collection](../packages/service/core/src/collection.ts) stores JSON records; [service](../packages/service/core/src/service.ts) supplies storage/namespace/clock context; [Timeline](../packages/core/src/timeline.ts) coordinates checkpoints and branches | Store container/run/ref/PR and deduplication state using shared conventions. Prove reset, namespace isolation, expiry boundaries and checkout coherence. Do not serialize sockets, waiters or process handles, or equate checkpoints with crash durability. |

## Delivery evidence

Research stories US-002, US-015 and US-024 resolve Context7 sources and reconcile
them with versioned primary contracts before API implementation. Revisit evidence
when operations or compatibility versions change. Exact status/error envelopes,
restart/retention rules and active-stream history semantics remain unresolved until
their owning stories supply evidence.

US-014, US-023 and US-031 own package build/lint/typecheck/tests,
contract/codegen/portability/pack checks, catalog/branding/docs integration and
canonical README/llms regeneration, followed by the root check. Generated support
matrices and self-parity are consistency evidence; independent consumer and real
oracle results must be reported separately. Unavailable or unauthorized oracle
execution leaves its story incomplete. No default daemon, operational repository,
real inference, deployment or external notification is an implicit test resource.
