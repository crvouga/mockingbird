# Implementation plan: Mockingbird infrastructure and orchestration mocks

## Objective and context

- Objective: deliver Mockingbird-only Docker Engine, Hermes peer-run, and GitHub REST mocks, in that order.
- Requirements: [feature PRD](../../prd-infrastructure-orchestration-mocks.md). Each story maps one-to-one to the same PRD ID.
- Scope: public provider contracts, stateful scenarios, socket transport, independent consumer fixtures, differential verification, package documentation, and justified shared-runtime improvements.
- Non-goals: Initiative implementation, systemd package assessment, consumer policy, and host enforcement. Those remain in the [separate Initiative handoff](../../avengers-initiative-mock-integration-handoff.md).
- Owner: Mockingbird for every story. No Initiative story is an execution dependency.
- Working branch: `ralph/infrastructure-orchestration-mocks` (created and checked out with user authorization). Commit the planning baseline before story execution.
- Mode: standard, subject to the installed shared mode/risk and staged-review contract.
- Authorization: the user explicitly approved the planning baseline commit and implementation of all 31 stories with one commit per story after required checks and review pass. Installs, restricted configuration changes, provider operations, and publication retain their separate authorization gates.
- Delivery: one explicitly authorized commit per verified and reviewed story; no automatic push or deployment.
- Current status: US-001 through US-031 are complete; no stories remain incomplete.

## Verification and execution rules

Every story inherits the shared requirements and verification rules in the PRD.
Use the affected package's configured `bun test`, `bun run typecheck`, and
`bun run lint`; format only intended files with the configured Biome tooling.
Package gates also include `bun run openapi:check`, `bun run generate`,
`bun run build`, `bun run portability`, and `bun run pack:check`. At delivery,
regenerate canonical documentation with `bun run readme:sync` and
`bun run llms:sync`, then run root `bun run check`. Recheck actual commands before
execution; do not treat unavailable tooling or skipped oracles as passing checks.
Documentation-only stories need source/link validation rather than artificial tests.

Context7 research gates are US-002, US-015, and US-024. Refresh evidence for new
operation families or version changes. Docker oracle runs use the latest Engine
available through the user's Docker Desktop installation, recording the exact
installed version and supported API range; never require a local downgrade.
The mock's declared API v1.52 contract is a compatibility target, not an Engine
installation requirement. US-013 recorded Engine 29.8.0 evidence against that
API subset; later Engine updates require fresh evidence for affected claims.
For Hermes and GitHub, historical or current-main documentation cannot silently
replace the required versioned contract. See the PRD for remaining provider
version questions and the story evidence for resolved runtime semantics.

### Shared workflow checklist for each story

- [ ] Verify execution/commit authorization, exact prepared branch, project instructions, and preserved unrelated work.
- [ ] Recheck the story's source evidence and implement only its scoped deliverable with meaningful tests.
- [ ] Run applicable formatting, lint, typecheck, tests, and package/oracle gates; report missing checks.
- [ ] Stage the intended candidate and apply the installed shared mode-aware review gate.
- [ ] Resolve findings and rerun affected checks within the shared review budget.
- [ ] Append execution evidence to `docs/progress.md`, update bounded validated review knowledge in `memory.json` when required, and complete the authorized per-story commit.

Implementation advisors are optional, read-only, and limited by the shared mode
budget (at most two); none is preassigned. Native Markdown staged review uses
`story-reviewer` when required. Self-review is not independent review. Missing
required reviewer capability is a blocker, not permission to substitute another role.

## Ordered stories

### US-001: Define package boundaries and scenario ownership

- [x] Story complete
- Priority: 1
- Depends on: none
- Relevant paths: `docs/INFRASTRUCTURE_MOCKS.md`, feature PRD.
- User story: As a maintainer, I want a compatibility matrix separating public mock behavior from consumer and host policy.
- Notes: All stories satisfy their corresponding PRD section and shared requirements; no Initiative story is an execution dependency. Follow installed execution/review guidance only after authorization. Execution history belongs in docs/progress.md and bounded review knowledge in memory.json; planning creates neither.

#### Acceptance criteria

- [ ] Create docs/INFRASTRUCTURE_MOCKS.md with provider boundaries and scenario IDs classified as portable, socket, oracle, or external-consumer evidence.
- [ ] Document targeted code-improvement hypotheses without assuming defects or requiring changes outside Mockingbird.
- [ ] Verify source references and links against the PRD US-001 requirements.
- [ ] Typecheck passes

### US-002: Research and pin the Docker API contract

- [x] Story complete
- Priority: 2
- Depends on: US-001
- Relevant paths: `packages/service/docker/API_EVIDENCE.md`, official versioned Engine specification.
- User story: As a Docker client developer, I want version-specific evidence before writing mock endpoints.
- Notes: API_EVIDENCE.md lives in packages/service/docker. Unresolved source/version semantics block their affected claims.

#### Acceptance criteria

- [ ] Resolve Docker in Context7 and query the required operations and attach transport; record retrieval date, library ID, URLs, versions, claims, and gaps in API_EVIDENCE.md.
- [ ] Reconcile observed v1.52 attach and unversioned info calls with the official versioned specification; historical Context7 excerpts alone are insufficient.
- [ ] Enumerate supported operations, errors, framing, excluded modes, and the proposed real Engine oracle version without claiming installed verification.
- [ ] Typecheck passes

### US-003: Scaffold the Docker service package

- [x] Story complete
- Priority: 3
- Depends on: US-002
- Relevant paths: `packages/service/docker/`, `docs/AUTHORING_A_SERVICE.md`.
- User story: As a consumer, I want standard Docker mock entry points and runtime controls.
- Notes: Follow AUTHORING_A_SERVICE.md and obtain required dependency/build-configuration approval before edits.

#### Acceptance criteria

- [ ] Add packages/service/docker with annotated OpenAPI, generated types/SUPPORT.md, portable runtime, Node server/CLI, WIP metadata, and initial README exports.
- [ ] Verify health, reset, namespace isolation, redacted journal, and shared Timeline coordination.
- [ ] Classify upgrade operations for protocol-specific verification rather than pretending Fetch supports them.
- [ ] Tests pass
- [ ] Typecheck passes

### US-004: Implement Docker engine and container observations

- [x] Story complete
- Priority: 4
- Depends on: US-003
- Relevant paths: `packages/service/docker/src/`, contract, operation and state tests.
- User story: As a client, I want coherent engine information and seeded container inspection.
- Notes: Refresh Context7 evidence for newly introduced operation families.

#### Acceptance criteria

- [ ] Implement contracted discovery/version/info and container read/list operations with provider errors and scoped filtering.
- [ ] Provide synthetic admin seeding and keep image identity, container identity, lifecycle state, and daemon availability distinct.
- [ ] Verify reset/isolation and label rootless metadata as simulated rather than host attestation.
- [ ] Tests pass
- [ ] Typecheck passes

### US-005: Implement Docker container creation

- [x] Story complete
- Priority: 5
- Depends on: US-004
- Relevant paths: `packages/service/docker/src/`, creation contract and tests.
- User story: As a launcher client, I want created containers to persist and obey supported creation rules.
- Notes: Durable records use the shared Collection/storage conventions.

#### Acceptance criteria

- [ ] Implement contracted create inputs, immutable IDs, name conflicts, missing-image errors, and launch metadata.
- [ ] Test concurrent name conflicts, create/inspect consistency, reset, and Timeline behavior.
- [ ] Do not execute images or describe stored configuration as enforced host isolation.
- [ ] Tests pass
- [ ] Typecheck passes

### US-006: Implement Docker start and wait

- [x] Story complete
- Priority: 6
- Depends on: US-005
- Relevant paths: `packages/service/docker/src/`, lifecycle/wait tests.
- User story: As a launcher client, I want controllable execution and completion observations.
- Notes: Prefer deterministic transition controls over arbitrary sleeps.

#### Acceptance criteria

- [ ] Implement contracted start behavior, wait conditions, and explicit scripted completion/exit codes.
- [ ] Verify repeated starts and waits against the researched contract.
- [ ] Cancel pending waiters on client cancellation, reset, and server close without executing containers.
- [ ] Tests pass
- [ ] Typecheck passes

### US-007: Implement Docker termination and removal

- [x] Story complete
- Priority: 7
- Depends on: US-006
- Relevant paths: `packages/service/docker/src/`, termination/removal tests.
- User story: As a recovery client, I want stop requests distinguished from completed termination.
- Notes: Follow PRD US-007 rather than reproducing consumer admission policy.

#### Acceptance criteria

- [ ] Implement contracted stop, kill, and removal operations with provider state checks and error envelopes.
- [ ] Provide controlled delayed termination and removal conflicts.
- [ ] Verify stop acceptance and socket loss alone do not automatically establish modeled retirement.
- [ ] Tests pass
- [ ] Typecheck passes

### US-008: Implement Docker failure scenarios and history consistency

- [x] Story complete
- Priority: 8
- Depends on: US-007
- Relevant paths: `packages/service/docker/src/runtime.ts`, provider tests, `packages/service/core/src/runtime.ts` and shared regressions if justified.
- User story: As a test author, I want reproducible failures before and after accepted mutations.
- Notes: No provider-local rollback/history coordinator and no blanket commit-on-error semantics.

#### Acceptance criteria

- [ ] Provide pre-mutation failure and accepted-but-response-lost presets with independent daemon availability and container execution state.
- [ ] Define logical restart outcomes explicitly and assert state, journal, and Timeline behavior after faults.
- [ ] If a regression proves shared runtime history loses accepted mutations on delivery failure, make the smallest compatible shared fix with existing-provider regression evidence.
- [ ] Tests pass
- [ ] Typecheck passes

### US-009: Implement Docker Unix-socket serving

- [x] Story complete
- Priority: 9
- Depends on: US-008
- Relevant paths: `packages/service/docker/src/server.ts`, Node transport modules and socket tests.
- User story: As a socket consumer, I want an isolated Engine-compatible server without Docker.
- Notes: Raw-socket fixtures are local to this package; Linux peer/procfs provenance is not simulated proof.

#### Acceptance criteria

- [ ] Add Node-only Unix-socket serving and supported TCP HTTP with retained sequential connections and bounded request handling.
- [ ] Test deliberate disconnects and owned connection/socket cleanup; refuse existing unowned socket paths.
- [ ] Keep Node imports outside portable entry points and avoid real Engine access in ordinary tests.
- [ ] Tests pass
- [ ] Typecheck passes

### US-010: Implement the Docker attach handshake

- [x] Story complete
- Priority: 10
- Depends on: US-009
- Relevant paths: Docker Node server/upgrade modules, handshake tests, `API_EVIDENCE.md`.
- User story: As an attach client, I want the actual HTTP upgrade contract.
- Notes: Recheck current Context7 and versioned upstream attach documentation before transport implementation.

#### Acceptance criteria

- [ ] Implement the supported versioned attach query and HTTP 101 headers through a Node upgrade path.
- [ ] Test fragmented handshake output and preservation of the first stream bytes.
- [ ] Test unsupported modes, missing containers, and aborted-handshake cleanup; document the Fetch limitation.
- [ ] Tests pass
- [ ] Typecheck passes

### US-011: Implement Docker attach stream framing and lifetime

- [x] Story complete
- Priority: 11
- Depends on: US-010
- Relevant paths: Docker attach/stream modules, framing and lifetime tests.
- User story: As an attached client, I want realistic duplex framing and cleanup.
- Notes: Keep provider-specific transport local until a second consumer justifies sharing it.

#### Acceptance criteria

- [ ] Encode contracted stdout/stderr multiplexing and supported stdin behavior.
- [ ] Verify partial frames, backpressure, EOF, cancellation, and transport loss while execution survives.
- [ ] Define reset/checkout/shutdown behavior and prevent stale streams from emitting restored or successor output; never snapshot socket handles.
- [ ] Tests pass
- [ ] Typecheck passes

### US-012: Verify Docker behavior and consumer wire compatibility

- [x] Story complete
- Priority: 12
- Depends on: US-011
- Relevant paths: Docker property/acceptance/protocol tests and package-owned consumer fixtures.
- User story: As a consumer, I want independent tests of the modeled Docker contract.
- Notes: Tests demonstrate protocol behavior, not Initiative's duplicate-launch or maintenance policy.

#### Acceptance criteria

- [ ] Add eligible self-parity, operation coverage assertions, and deliberate divergence detection.
- [ ] Add Mockingbird-owned retained-HTTP and attach consumers covering mutation, response loss, and re-inspection.
- [ ] Exercise an actual pinned SDK where applicable without replacing raw-socket contract coverage or importing Initiative.
- [ ] Tests pass
- [ ] Typecheck passes

### US-013: Add and exercise the Docker differential oracle

- [x] Story complete
- Priority: 13
- Depends on: US-012
- Relevant paths: Docker parity scripts, differential fixtures and evidence.
- User story: As a maintainer, I want independent evidence against a selected real Engine.
- Notes: Use the current user-selected Engine, recording its exact version and API range; do not require a host downgrade. Compare the declared API v1.52 subset when supported. Docker lifecycle operations require explicit authorization; building the harness alone is not completed parity.

#### Acceptance criteria

- [ ] Add opt-in lifecycle/attach comparisons requiring explicit endpoint, version, owned resources, and scoped cleanup.
- [ ] Run authorized scenarios and record actual versions, normalized comparisons, and gaps; never silently use the default host daemon.
- [ ] Separate transport-fault evidence from real restart/live-restore evidence; missing oracle execution leaves this story incomplete.
- [ ] Tests pass
- [ ] Typecheck passes

### US-014: Deliver Docker documentation and package gates

- [x] Story complete
- Priority: 14
- Depends on: US-013
- Relevant paths: Docker README/support/evidence/metadata, `sites/docs/`, canonical README/llms generators.
- User story: As a consumer, I want an installable Docker mock with explicit compatibility limits.
- Notes: Obtain required dependency/build approvals; do not publish or deploy as a gate side effect.

#### Acceptance criteria

- [ ] Complete README/API/transport examples, presets, support matrix, and API evidence with host-isolation exclusions.
- [ ] Integrate catalog/category/branding/docs metadata and regenerate README and llms outputs from canonical sources.
- [ ] Pass contract, codegen, lint, build, portability, pack, and root bun run check gates; retain WIP absent independent Ready evidence.
- [ ] Tests pass
- [ ] Typecheck passes

### US-015: Research and pin Hermes peer-run behavior

- [x] Story complete
- Priority: 15
- Depends on: US-014
- Relevant paths: `packages/service/hermes/API_EVIDENCE.md`, pinned upstream source.
- User story: As a peer client developer, I want the pinned public API contract before implementation.
- Notes: Sequenced after Docker delivery. Never fabricate a Context7 version or equate current main with the pinned tag.

#### Acceptance criteria

- [ ] Resolve Hermes in Context7 and query public peer operations; record current documentation and reconcile with v2026.8.31 source in API_EVIDENCE.md.
- [ ] Specify submission, polling, stop, fingerprint/scope, interruption, and retention with exact envelopes and source provenance.
- [ ] Separate peer-run, Kanban-attempt, and client-intake identity; unresolved semantics remain explicit blockers.
- [ ] Typecheck passes

### US-016: Scaffold the Hermes service package

- [x] Story complete
- Priority: 16
- Depends on: US-015
- Relevant paths: `packages/service/hermes/`, `docs/AUTHORING_A_SERVICE.md`.
- User story: As a consumer, I want standard public peer-run mock entry points.
- Notes: No Kanban implementation, dispatcher compatibility layer, or inference dependency.

#### Acceptance criteria

- [ ] Add packages/service/hermes with annotated contract/codegen, WIP metadata, portable runtime, Node server/CLI, and initial README.
- [ ] Verify standard controls and namespace isolation.
- [ ] Keep prompts, results, and credentials out of journals and use minimal resettable synthetic state.
- [ ] Tests pass
- [ ] Typecheck passes

### US-017: Implement Hermes submission and polling

- [x] Story complete
- Priority: 17
- Depends on: US-016
- Relevant paths: `packages/service/hermes/src/`, submit/poll contract and tests.
- User story: As a peer client, I want tracked runs without executing an agent.
- Notes: Refresh Context7 and pinned-source evidence for changed or newly introduced operations.

#### Acceptance criteria

- [ ] Implement POST /v1/runs and GET /v1/runs/{id} under the pinned contract.
- [ ] Provide scripted lifecycle observations with required fields, opaque IDs, and observed error/missing-run envelopes.
- [ ] Verify submission/poll consistency through supported states without an agent executor.
- [ ] Tests pass
- [ ] Typecheck passes

### US-018: Implement Hermes idempotency

- [x] Story complete
- Priority: 18
- Depends on: US-017
- Relevant paths: Hermes state/idempotency modules and concurrency/replay tests.
- User story: As a retrying peer client, I want duplicate submissions and conflicts distinguished.
- Notes: Follow PRD FR-14: scoped synthetic state does not implement real profile credential enforcement.

#### Acceptance criteria

- [ ] Match pinned fingerprinting and synthetic profile/session scope.
- [ ] Identical replay returns the original run, conflicting reuse fails, and concurrent identical requests create exactly one run.
- [ ] Retain scoped deduplication through modeled restart without inventing lookup APIs or changing authorization logic.
- [ ] Tests pass
- [ ] Typecheck passes

### US-019: Implement Hermes stop and interruption

- [x] Story complete
- Priority: 19
- Depends on: US-018
- Relevant paths: Hermes lifecycle/runtime modules and interruption/stop tests.
- User story: As a peer client, I want accurate stop and gateway-interruption observations.
- Notes: Current documentation is not a substitute for the pinned stop semantics.

#### Acceptance criteria

- [ ] Implement the pinned stop route and intermediate/completion states without treating acceptance as completed execution.
- [ ] Apply pinned logical-restart behavior to unfinished and terminal runs.
- [ ] Test interrupted-run replay separately from a new delivery key and prevent silent revival of the old run.
- [ ] Tests pass
- [ ] Typecheck passes

### US-020: Implement Hermes retention and history

- [x] Story complete
- Priority: 20
- Depends on: US-019
- Relevant paths: Hermes state/retention modules and clock/history tests.
- User story: As a test author, I want reproducible expiry and restoration.
- Notes: Use shared Timeline only.

#### Acceptance criteria

- [ ] Implement pinned result and idempotency retention using the controlled clock, including exact boundary cases.
- [ ] Return observed missing/expired API behavior instead of inventing a lifecycle state.
- [ ] Restore run, deduplication, clock, and retention state coherently; distinguish logical restart from process-crash durability.
- [ ] Tests pass
- [ ] Typecheck passes

### US-021: Verify Hermes faults and consumer contracts

- [x] Story complete
- Priority: 21
- Depends on: US-020
- Relevant paths: Hermes fault controls, property/acceptance tests and consumer fixtures.
- User story: As a peer client, I want reproducible uncertainty and independent contract tests.
- Notes: Keep response-loss state/journal/history assertions independent of consumer intake policy.

#### Acceptance criteria

- [ ] Add accepted-run/response-loss, timeout, throttle, and scripted provider-error scenarios with pinned envelopes.
- [ ] Add eligible self-parity, coverage assertions, and deliberate divergence detection.
- [ ] Exercise submit/poll/stop, replay, and expiry through a Mockingbird-owned HTTP consumer; do not import Initiative or claim credential enforcement.
- [ ] Tests pass
- [ ] Typecheck passes

### US-022: Add and exercise the pinned Hermes oracle

- [x] Story complete
- Priority: 22
- Depends on: US-021
- Relevant paths: Hermes parity scripts, pinned-runtime fixtures and evidence.
- User story: As a maintainer, I want public API comparisons with real pinned lifecycle code.
- Notes: Do not require Initiative or silently install dependencies, initialize operational databases, or run inference.

#### Acceptance criteria

- [ ] Add an opt-in exact-version oracle using disposable state and a deterministic non-inference executor.
- [ ] Retain upstream run, idempotency, and storage behavior; document all substitutions and avoid operational boards or external deliveries.
- [ ] Execute authorized replay/conflict/stop/restart/retention comparisons and record provenance; unavailable pinned execution leaves this story incomplete.
- [ ] Tests pass
- [ ] Typecheck passes

### US-023: Deliver Hermes documentation and package gates

- [x] Story complete
- Priority: 23
- Depends on: US-022
- Relevant paths: Hermes README/support/evidence/metadata, `sites/docs/`, canonical README/llms generators.
- User story: As a consumer, I want a documented version-specific peer-run test double.
- Notes: Delivery is independent of Initiative adoption.

#### Acceptance criteria

- [ ] Complete README/API examples, presets, pin/evidence, and explicit Python dispatcher/Kanban/inference exclusions.
- [ ] Integrate catalog/branding/docs metadata and regenerate README and llms outputs.
- [ ] Pass contract, codegen, lint, build, portability, pack, and root bun run check gates; retain WIP absent independent Ready evidence.
- [ ] Tests pass
- [ ] Typecheck passes

### US-024: Research and define the GitHub REST subset

- [x] Story complete
- Priority: 24
- Depends on: US-023
- Relevant paths: `packages/service/github/API_EVIDENCE.md`, official OpenAPI source.
- User story: As a publication-client developer, I want accurate documented API semantics.
- Notes: Sequenced after Hermes delivery. Broker atomic-update selection is an Initiative task, not this story.

#### Acceptance criteria

- [ ] Resolve GitHub REST in Context7 and query repositories, refs, and PRs; record source/OpenAPI revision, retrieval date, and API-version header in API_EVIDENCE.md.
- [ ] Define pagination, errors, identities, and scope; explicitly record absent REST expected-old-SHA and universal PR idempotency guarantees.
- [ ] Keep the public API contract independent of Initiative broker transport selection.
- [ ] Typecheck passes

### US-025: Scaffold GitHub and implement repository observations

- [x] Story complete
- Priority: 25
- Depends on: US-024
- Relevant paths: `packages/service/github/`, repository state and observation tests.
- User story: As a client, I want a synthetic GitHub repository surface with standard controls.
- Notes: No GitHub App token issuance or production authorization implementation.

#### Acceptance criteria

- [ ] Add packages/service/github with contract/codegen, WIP metadata, runtime, server/CLI, initial README, and control/isolation tests.
- [ ] Implement repository identity/default-branch observations and provider-shaped missing-resource responses.
- [ ] Provide explicit synthetic commit/ancestry seeding without implementing Git transport.
- [ ] Tests pass
- [ ] Typecheck passes

### US-026: Implement GitHub reference reads and mutations

- [x] Story complete
- Priority: 26
- Depends on: US-025
- Relevant paths: GitHub ref handlers/state, contract and ancestry/conflict tests.
- User story: As a client, I want coherent reference state and real REST conflict semantics.
- Notes: Refresh Context7 evidence when expanding ref operations.

#### Acceptance criteria

- [ ] Implement contracted ref read/list/create/update over seeded commit ancestry.
- [ ] Test missing objects/refs, name conflicts, non-fast-forward errors, and concurrent head movement.
- [ ] Model force semantics accurately or mark them unsupported; never invent an expected-old-SHA request field or guarantee and never force-push in live tests.
- [ ] Tests pass
- [ ] Typecheck passes

### US-027: Implement GitHub PR creation and reconciliation reads

- [x] Story complete
- Priority: 27
- Depends on: US-026
- Relevant paths: GitHub PR handlers/state, contract, lookup and pagination tests.
- User story: As a client, I want remote PR state discoverable after uncertain creation.
- Notes: Actual publication journals and broker state machines remain outside this package.

#### Acceptance criteria

- [ ] Implement contracted PR create/get/list/update, filters, and pagination.
- [ ] Preserve repository/head/base/number/SHA relationships and actual duplicate-creation errors.
- [ ] Verify lost-acknowledgement lookup without inventing server-side consumer operation-ID deduplication.
- [ ] Tests pass
- [ ] Typecheck passes

### US-028: Implement GitHub publication fault presets

- [x] Story complete
- Priority: 28
- Depends on: US-027
- Relevant paths: GitHub runtime/fault controls and response-loss/history tests.
- User story: As a test author, I want mutation outcomes independent of response delivery.
- Notes: Reuse demonstrated shared runtime behavior rather than duplicating fault/history infrastructure.

#### Acceptance criteria

- [ ] Add pre-mutation errors, accepted-write/response-loss, rate-limit headers, and intervening ref movement controls.
- [ ] Provide scripted provider-shaped denied responses without implementing GitHub App credentials or authorization policy.
- [ ] Verify state, metadata-only journal, and history after faults without claiming real branch enforcement or atomic publication.
- [ ] Tests pass
- [ ] Typecheck passes

### US-029: Verify GitHub contracts and independent consumers

- [x] Story complete
- Priority: 29
- Depends on: US-028
- Relevant paths: GitHub property/acceptance tests and package-owned consumer fixtures.
- User story: As a client developer, I want tests sensitive to incorrect REST semantics.
- Notes: Git transport and application approval lineage are separate consumer responsibilities.

#### Acceptance criteria

- [ ] Add self-parity operation coverage and deliberate divergent-instance detection.
- [ ] Add Mockingbird-owned consumer scenarios for lost PR responses, ref movement, duplicates, pagination, and retry-after handling.
- [ ] Verify fixtures do not add fictional compare-and-swap or universal idempotency; no Initiative broker execution is required.
- [ ] Tests pass
- [ ] Typecheck passes

### US-030: Add and exercise a bounded GitHub oracle

- [x] Story complete
- Priority: 30
- Depends on: US-029
- Relevant paths: GitHub parity scripts, disposable-repository fixtures and evidence.
- User story: As a maintainer, I want real API evidence scoped to disposable resources.
- Notes: Simulated access denial is not actual App-identity or repository-rules proof.

#### Acceptance criteria

- [ ] Add opt-in comparisons requiring explicit disposable repository, API version, operation subset, and ownership/cleanup scope.
- [ ] Execute only separately authorized writes and notifications; no default-branch updates, merges, force-pushes, or unrelated resource changes.
- [ ] Report missing credential key names without values, actual compared operations, and verification gaps; unavailable oracle execution leaves this story incomplete.
- [ ] Tests pass
- [ ] Typecheck passes

### US-031: Deliver GitHub documentation and package gates

- [x] Story complete
- Priority: 31
- Depends on: US-030
- Relevant paths: GitHub README/support/evidence/metadata, `sites/docs/`, canonical README/llms generators.
- User story: As a consumer, I want an installable REST mock with honest publication limits.
- Notes: All deliverables are Mockingbird-local; systemd package reassessment and cross-component Initiative acceptance are in the separate handoff.

#### Acceptance criteria

- [ ] Complete README/API examples, presets, support/evidence, and Git transport/token/ruleset/atomicity exclusions.
- [ ] Integrate catalog/branding/docs metadata and regenerate README and llms outputs.
- [ ] Pass contract, codegen, lint, build, portability, pack, and root bun run check gates; retain WIP absent independent Ready evidence.
- [ ] Tests pass
- [ ] Typecheck passes

## Resume and delivery

For authorized execution, load the installed `prepare-implementation` skill and
its `references/story-execution.md` and `references/story-review.md`, using the
Markdown task-source guidance. Do not launch Ralph or a Goal merely because this
plan exists. Missing references, branch preparation, authorization, or required
review capability block execution.

Read this plan and relevant latest `docs/progress.md` entries and `memory.json`
when present, relative to the Git worktree root. Keep commands/results, actual
review/advisor use, findings, blockers, and commit evidence in the append-only
progress journal rather than expanding this plan. Missing memory is normal:
use empty version-1 memory in process and create it only after passing review;
preserve invalid memory and stop. Keep at most 20 patterns and 20 suppressions.
This format conversion creates neither execution-state file.

Apply the shared mode/risk budget and packet preflight. When native review is
required, embed the complete protocol/schema directly in the reviewer invocation,
start a separate `story-reviewer` session per story/attempt, and record the actual
role and returned session ID. Permit at most one initial plus one targeted
same-session follow-up; blocked or malformed review stops delivery.

Recheck the prepared branch before changes, staging, and commit. Mark story
completion only through the shared check/review/authorized-commit lifecycle; restore
provisional markers and record the blocker if commit fails. No implicit branch
switching, pushes, external posts, provider operations, or additional permissions.

- [ ] Final report records actual commits, checks/review outcomes, delivered scope, and remaining gaps.

After all stories are verified and committed, archival requires separate approval
and the installed skill's completed-run archival procedure. Do not move active
state or reset existing execution evidence as a planning side effect.
