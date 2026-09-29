# PRD: Mockingbird infrastructure and orchestration mocks

Status: requirements and implementation-plan draft requested September 25, 2026.
Scope: changes within Mockingbird only. This document authorizes no execution,
installation, publication, deployment, or changes to another repository.

## 1. Overview

Add stateful Docker Engine, Hermes Agent peer-run, and GitHub REST API mocks in
that delivery order. Their value is reproducing accepted operations with lost
responses, retained execution after connection loss, idempotent replay, and remote
state changes that ordinary canned responses cannot represent.

The consumer use cases come from Avengers Initiative, but these packages model
public third-party interfaces, not Initiative's private control services or policy.
Initiative-owned implementation, host tests, and adoption are tracked separately
in the [Initiative handoff](avengers-initiative-mock-integration-handoff.md).
No Initiative task is part of [the archived Mockingbird plan](archive/infrastructure-orchestration-mocks/PLAN.md).

### Planned packages

| Delivery | Package | Boundary |
| --- | --- | --- |
| 1 | `@crvouga/mockingbird-service-docker` | Engine HTTP observations and lifecycle, Unix sockets, attach upgrade/streams |
| 2 | `@crvouga/mockingbird-service-hermes` | Public tracked peer runs, idempotency, stopping, interruption, retention |
| 3 | `@crvouga/mockingbird-service-github` | Repository/ref observations, supported ref mutations, pull requests, response-loss scenarios |

All packages begin as `wip`. Names and API coverage are requirements; unverified
provider semantics and exact Engine/GitHub version choices remain open questions.

## 2. Goals

- Make the supported failure sequences reproducible with synthetic data and no
  provider accounts in normal tests.
- Supply coherent state across create/read/update and retry sequences.
- Exercise real wire formats, including Docker's non-Fetch upgrade surface.
- Gather current API documentation through Context7 before writing each provider
  contract; independently reconcile it with the compatibility target.
- Prove selected behavior through independent consumer fixtures and real-provider
  differential checks, with missing evidence explicitly reported.
- Keep each provider usable and releasable independently of Initiative adoption.
- Improve shared runtime code only when a failing regression demonstrates a need.

## 3. Documentation and evidence requirements

For each provider, create `packages/service/<name>/API_EVIDENCE.md`. Before API
implementation, resolve the official library in Context7 and query documentation
for the specific operations and transport being implemented. Repeat this step for
new operation families or version changes; earlier research is not a perpetual
freshness guarantee.

Record retrieval date, library ID, source URL, source revision/version when
available, requested compatibility version, operation, extracted behavioral claim,
and whether the evidence is documentation, pinned source, or observed parity.
Record discrepancies and missing coverage; do not silently choose a convenient
behavior. Never include credentials, real prompts, or customer data in queries.

When Context7 returns old or unpinned material, use the official versioned API
specification or pinned upstream source to fill the gap. Current documentation is
not evidence of an older pinned runtime. A missing source blocks the affected
claim, not unrelated implementation. Do not fabricate a supported Context7 version.

### Research performed for this draft

| Provider | Context7 library | Finding and remaining gap |
| --- | --- | --- |
| Docker | `/docker/docs` | Attach queries returned historical API examples; these are not sufficient evidence for v1.52. Fetch the official versioned Engine specification before implementing. |
| Hermes | `/nousresearch/hermes-agent` | Current main documents tracked runs and stopping. The resolver did not advertise `v2026.8.31`; inspect that pinned tag for compatibility rather than assuming main matches. |
| GitHub | `/websites/github_en_rest` | REST ref update exposes `sha` and `force`, not an expected-old-SHA parameter. Recheck PR operations and the selected API-version header before implementation. |

Primary starting points: [Docker Engine API](https://docs.docker.com/reference/api/engine/),
[pinned Hermes run handlers](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/gateway/platforms/api_server_runs.py),
[GitHub refs](https://docs.github.com/en/rest/git/refs),
[GitHub PRs](https://docs.github.com/en/rest/pulls/pulls).
No parity or installed-version verification was performed during drafting.

## 4. Individual deliverables and user stories

Each `US-*` below maps one-to-one to `PLAN.md`. Dependencies refer only to
Mockingbird deliverables; delivery order is Docker, Hermes, GitHub. Every story
requires **Typecheck passes**. Every story with testable behavior also requires
**Tests pass**, using focused meaningful checks. Those criteria are explicit in
the task plan. Documentation-only stories require link/source consistency checks,
not manufactured behavior tests.

### US-001: Define package boundaries and scenario ownership

As a maintainer, I want a compatibility matrix so that public mock behavior and
consumer policy are not conflated.

- [ ] Add `docs/INFRASTRUCTURE_MOCKS.md` with package boundaries and scenario IDs.
- [ ] Label each scenario as portable behavior, socket protocol, external oracle,
  or consumer/host responsibility.
- [ ] Record the expected code improvements: post-mutation fault/history
  consistency, transport lifetime cleanup, and replayable state where justified.
- [ ] No implementation work in another repository is required to complete this story.

### US-002: Research and pin the Docker API contract

As a Docker client developer, I want version-specific evidence so that the mock
speaks the API actually consumed.

- [ ] Use Context7 and create Docker `API_EVIDENCE.md` under the evidence rules.
- [ ] Reconcile observed `/v1.52/...` attach requests and unversioned `/info` with
  the official versioned spec; document supported versions and rejection behavior.
- [ ] Enumerate required paths, parameters, statuses, identity fields, error shapes,
  and attach framing; identify unsupported TTY, exec, logs, and event modes.
- [ ] Select the real Engine oracle version; if unavailable, record the selection
  blocker rather than calling the installed version verified.

### US-003: Scaffold the Docker service package

As a consumer, I want standard package entry points and runtime controls.

- [ ] Add `packages/service/docker` with vendored/annotated `openapi.yaml`, generated
  operation types and `SUPPORT.md`, portable entry, Node server entry, and CLI.
- [ ] Declare WIP status, category, exports, scripts, and runtime metadata using
  existing package conventions; author consumer README sections at scaffold time.
- [ ] Verify health, reset, namespaces, journal redaction, and no provider-local
  history coordinator; classify upgrade operations for protocol-specific testing.

### US-004: Implement Docker engine and container observations

As a client, I want engine information and seeded container inspection.

- [ ] Implement contracted engine discovery/version/info and container read/list
  operations with provider-shaped errors and filtering only where in scope.
- [ ] Seed synthetic images/containers through documented admin controls.
- [ ] Keep image identity, container identity, lifecycle state, and daemon
  availability distinct; simulated rootless fields are not host attestation.

### US-005: Implement Docker container creation

As a launcher client, I want creation to persist an inspectable container.

- [ ] Implement contracted creation inputs, immutable IDs, name conflicts, missing
  images, and error envelopes.
- [ ] Preserve supported launch-spec metadata without executing it; unsupported
  behavior is explicit rather than presented as enforced isolation.
- [ ] Verify create/inspect consistency, concurrent name conflicts, reset, and history.

### US-006: Implement Docker start and wait

As a launcher client, I want execution transitions and completion observations.

- [ ] Implement contracted start and wait conditions/statuses.
- [ ] Provide explicit scripted execution completion and exit codes; do not run images.
- [ ] Waiting remains pending until its condition is met and cleans up on client
  cancellation, reset, or server close; test repeated start behavior against the contract.

### US-007: Implement Docker termination and removal

As a recovery client, I want to distinguish stop requests from completed retirement.

- [ ] Implement the supported stop/kill/remove operations and their state checks.
- [ ] Model delayed completion and removal conflicts through explicit controls.
- [ ] A stop request or lost connection alone does not automatically terminate the
  modeled execution; verify subsequent inspection and wait results.

### US-008: Implement Docker failure scenarios and history consistency

As a recovery-test author, I want failures before and after mutations.

- [ ] Add operation-specific pre-mutation failure and accepted-but-response-lost presets.
- [ ] Model daemon unavailability independently of existing container execution;
  define logical restart scenarios that preserve or terminate containers explicitly.
- [ ] Assert state, metadata-only journal, and Timeline behavior after each failure.
- [ ] If the shared runtime loses accepted mutations from history when transport
  delivery fails, add a failing regression and the smallest shared correction;
  preserve compatibility for existing providers and never add local snapshot logic.

### US-009: Implement Docker Unix-socket serving

As a socket client, I want a local Engine-compatible transport without Docker.

- [ ] Add Node-only serving over a test-owned Unix-socket path plus ordinary HTTP
  where supported; keep the portable entry free of Node imports.
- [ ] Support retained sequential HTTP connections, bounded request handling, and
  deliberate disconnection without implicit client reconnection.
- [ ] Test cleanup of owned sockets/connections and refusal to overwrite an
  existing unowned socket path; never connect to the host Engine in ordinary tests.

### US-010: Implement the Docker attach handshake

As an attach client, I want the actual HTTP upgrade contract.

- [ ] Handle the supported versioned attach query through a Node upgrade path,
  including the contracted 101 status and headers.
- [ ] Fragment handshake delivery deterministically and preserve the first stream bytes.
- [ ] Verify rejection and cleanup for unsupported modes, missing containers, and
  aborted handshakes; document that Fetch mode cannot perform this upgrade.

### US-011: Implement Docker attach stream framing and lifetime

As an attached client, I want realistic duplex stream behavior.

- [ ] Encode contracted multiplexed stdout/stderr frames and supported stdin behavior.
- [ ] Test partial headers/payloads, byte boundaries, backpressure, EOF, cancellation,
  and disconnect while modeled execution survives.
- [ ] Define reset, checkout, and shutdown behavior for active streams: live socket
  handles are not snapshotted; stale streams cannot emit restored or successor output.

### US-012: Verify Docker behavior and consumer wire compatibility

As a consumer, I want failures caught independently of handler implementation.

- [ ] Add eligible OpenAPI self-parity walks, operation-coverage assertions, and
  deliberate divergence detection.
- [ ] Add Mockingbird-owned socket consumer fixtures for retained HTTP and attach,
  including accepted operation followed by lost response and re-inspection.
- [ ] Use an actual pinned SDK where the declared consumer uses one; raw protocol
  fixtures are required for the observed raw-socket consumer.
- [ ] Do not require importing or editing Initiative or claim its policies pass.

### US-013: Add and exercise the Docker differential oracle

As a maintainer, I want independent evidence against a selected real Engine.

- [ ] Add opt-in lifecycle and attach differential scenarios with explicit endpoint,
  version, resource ownership, and cleanup boundaries.
- [ ] Refuse implicit use of a developer's default daemon; require scoped lifecycle
  authorization and preserve unrelated containers/images.
- [ ] Record oracle version, executed operations, normalized comparisons, and
  limitations. Missing authorization/Engine evidence leaves this story incomplete.
- [ ] Record transport-fault tests separately from real daemon-restart/live-restore
  evidence; do not claim one proves the other.

### US-014: Deliver Docker documentation and package gates

As a consumer, I want an installable documented Docker test double.

- [ ] Complete README/API/transport examples, failure presets, support matrix, and
  API evidence; identify modeled observations versus actual isolation guarantees.
- [ ] Integrate service metadata, category, branding, and docs-site dependency;
  regenerate canonical README/llms outputs under repository rules.
- [ ] Pass package/build/portability/contract checks and `bun run check`; retain WIP
  until the repository's Ready requirements have independently been met.

### US-015: Research and pin Hermes peer-run behavior

As a peer client developer, I want the supported runtime's actual API contract.

- [ ] Use Context7; reconcile current docs with `v2026.8.31` source and record evidence.
- [ ] Specify submit, poll, stop, payload fingerprinting, idempotency scope, terminal
  states, restart behavior, and retention with exact response/error shapes.
- [ ] Separate public peer-run IDs from Kanban attempt IDs and client intake IDs.
- [ ] Record unknown semantics as blockers, not assumptions or silent latest-version upgrades.

### US-016: Scaffold the Hermes service package

As a consumer, I want standard public peer-run mock entry points.

- [ ] Add `packages/service/hermes`, annotated contract/codegen, WIP metadata,
  portable runtime, Node server/CLI, and initial consumer README.
- [ ] Verify standard controls, namespace isolation, and metadata-only journaling.
- [ ] Keep submitted prompts and result text out of journals; use minimal synthetic
  scripted state and clear it on reset.

### US-017: Implement Hermes submission and polling

As a peer client, I want tracked runs without executing an agent.

- [ ] Implement contracted `POST /v1/runs` and `GET /v1/runs/{id}`.
- [ ] Add deterministic scripted pending/running/terminal observations and required
  fields; preserve provider error envelopes and missing-run behavior.
- [ ] Verify create/read consistency and opaque identity; no Kanban or inference implementation.

### US-018: Implement Hermes idempotency

As a retrying peer client, I want duplicate and conflicting requests distinguished.

- [ ] Match pinned payload fingerprinting and scope with synthetic profiles/sessions.
- [ ] Identical replay returns the original run, conflicting reuse fails, and
  concurrent identical submissions create one modeled run.
- [ ] Retain scoped deduplication state through the modeled restart; do not invent
  an idempotency lookup endpoint or change consumer authorization policy.

### US-019: Implement Hermes stop and interruption

As a peer client, I want stopping and interrupted runs modeled accurately.

- [ ] Implement the pinned stop operation, including any intermediate state, with
  completion independent of initial request acceptance.
- [ ] A logical gateway restart applies observed pinned behavior to unfinished and
  terminal runs; interrupted runs are not silently revived.
- [ ] Test replay of the old run separately from submission with a replacement key.

### US-020: Implement Hermes retention and history

As a recovery-test author, I want expiry and restoration to be reproducible.

- [ ] Apply pinned idempotency/result retention using the controlled clock, including
  boundary-time behavior and independent lifetimes where upstream distinguishes them.
- [ ] Expired results return the observed API response rather than an invented terminal state.
- [ ] Checkpoint/restore covers run, deduplication, clock, and retention state;
  document logical restart versus actual process persistence.

### US-021: Verify Hermes faults and consumer contracts

As a peer client, I want realistic uncertainty and protocol evidence.

- [ ] Add accepted-run/response-loss, timeout, throttle, and scripted provider-error
  scenarios; labels/statuses follow the pinned contract.
- [ ] Add self-parity coverage and deliberate divergence detection.
- [ ] Exercise submit/poll/stop through a Mockingbird-owned HTTP consumer fixture,
  checking response loss, replay, and expiry without importing Initiative.
- [ ] Scripted denied responses do not claim to implement real credential enforcement.

### US-022: Add and exercise the pinned Hermes oracle

As a maintainer, I want public protocol comparisons with real Hermes lifecycle code.

- [ ] Build an opt-in differential harness against exact pinned Hermes with disposable
  state and no operational boards, real inference, or external deliveries.
- [ ] Retain upstream run/idempotency/storage behavior; substitute only the bounded
  executor required to avoid inference, and document any additional substitutions.
- [ ] Compare replay, conflicts, stop, restart, and retention; publish version and
  provenance of results. Unavailable pinned execution is an explicit incomplete gate.

### US-023: Deliver Hermes documentation and package gates

As a consumer, I want clear integration examples and compatibility limits.

- [ ] Complete README/API examples, presets, supported pin, oracle limitations, and
  the explicit exclusion of Python dispatch/Kanban/internal agent behavior.
- [ ] Integrate catalog/branding/docs metadata and regenerate README/llms outputs.
- [ ] Pass package/build/portability/contract checks and `bun run check`; retain WIP
  unless Ready evidence separately satisfies repository policy.

### US-024: Research and define the GitHub REST subset

As a publication-client developer, I want documented real API semantics.

- [ ] Use Context7 for refs, repository metadata, and PR operations; record the
  official OpenAPI revision and supported `X-GitHub-Api-Version` value.
- [ ] Define required pagination, errors, and ref/PR identity relationships.
- [ ] Explicitly document that REST ref update lacks an expected-old-SHA guard and
  PR creation has no assumed universal client idempotency key.
- [ ] Public API implementation can proceed without waiting for Initiative's
  broker design; broker atomic-update selection belongs to its separate plan.

### US-025: Scaffold GitHub and implement repository observations

As a client, I want a documented synthetic repository surface.

- [ ] Add `packages/service/github`, contract/codegen, WIP metadata, standard runtime,
  server/CLI, initial README, and namespace/reset tests.
- [ ] Implement repository identity and default-branch observations using seeded
  metadata and provider-shaped missing-resource responses.
- [ ] Seed minimal synthetic commit objects/ancestry through explicit admin controls;
  do not emulate Git object transfer or a Git server.

### US-026: Implement GitHub reference reads and mutations

As a client, I want coherent reference state and documented update behavior.

- [ ] Implement the supported read/list/create/update ref subset with seeded ancestry.
- [ ] Test missing refs/objects, name conflicts, non-fast-forward rejection, and
  concurrent head movement according to the selected API contract.
- [ ] Model supported force semantics accurately or explicitly mark them unsupported;
  live tests never force-push. Never invent an expected-old-SHA field or guarantee.

### US-027: Implement GitHub PR creation and reconciliation reads

As a client, I want remote PR state that can be rediscovered after response loss.

- [ ] Implement contracted create/get/list/update behavior, filters, and pagination.
- [ ] Preserve repository/head/base/number/SHA relationships and observed duplicate-PR errors.
- [ ] Test creation followed by lookup with a lost acknowledgement; do not add
  server deduplication based on a consumer-private publication operation ID.

### US-028: Implement GitHub publication fault presets

As a recovery-test author, I want remote mutations and response delivery separated.

- [ ] Add pre-mutation errors, accepted-write/response-loss, rate-limit headers,
  and explicit intervening ref movement scenarios.
- [ ] Script provider-shaped access-denied observations without reimplementing
  GitHub Apps, credential issuance, or production authorization policy.
- [ ] Verify remote state/journal/history after faults; presets cannot claim real
  branch-protection enforcement or atomic publication.

### US-029: Verify GitHub contracts and independent consumers

As a client developer, I want independent checks of the supported REST behavior.

- [ ] Add OpenAPI self-parity with operation-coverage assertions and a deliberate
  divergent-instance test.
- [ ] Add Mockingbird-owned consumer scenarios for lost PR-create responses, ref
  movement, duplicate creation, pagination, and retry-after handling.
- [ ] Verify no fictional compare-and-swap or universal idempotency semantics appear
  in fixtures; full broker recovery and Git transport remain external consumer tests.

### US-030: Add and exercise a bounded GitHub oracle

As a maintainer, I want real API comparison evidence without touching unrelated work.

- [ ] Add an opt-in harness restricted to an explicitly authorized disposable repository,
  owned resources, selected API version, and predeclared operation subset.
- [ ] Credential absence reports key names only and cannot be a passing parity result.
- [ ] Require scoped approval for remote writes/notifications and cleanup; no
  default-branch updates, merges, or force-pushes occur.
- [ ] Record actual compared operations and limits; simulated denial is not real
  App-identity or repository-rules verification.

### US-031: Deliver GitHub documentation and package gates

As a consumer, I want installable REST mocks with honest publication guarantees.

- [ ] Complete README/API examples, fault controls, API evidence, supported operations,
  and explicit Git transport/token/ruleset/atomicity exclusions.
- [ ] Integrate catalog/branding/docs metadata and regenerate README/llms outputs.
- [ ] Pass package/build/portability/contract checks and `bun run check`; retain WIP
  unless Ready evidence separately satisfies repository policy.

## 5. Functional requirements

- **FR-1:** All implementation stories modify Mockingbird only. Source references
  to another repository are evidence, not dependencies on executing its code.
- **FR-2:** Each provider must perform Context7 research before API implementation
  and maintain version-aware API evidence as defined in section 3.
- **FR-3:** Contracts declare supported operations, all returned statuses, and
  explicit unsupported behavior; generated files come from their canonical sources.
- **FR-4:** Portable APIs expose Fetch where possible; Docker socket/upgrade paths
  are Node-only with explicit portability metadata and independent protocol tests.
- **FR-5:** Durable observable state uses shared storage and Timeline coordination.
  Mutable transport handles must not be serialized as provider state.
- **FR-6:** Accepted operations survive lost responses in modeled state. Fault
  timing is observable, reproducible, and distinguishable from rejected operations.
- **FR-7:** Lifecycle state, transport availability, and client observation remain
  separate; socket closure alone does not terminate modeled execution.
- **FR-8:** Normal tests require no daemon, accounts, credentials, inference, or
  installed copy of Initiative. Optional oracle prerequisites remain explicit.
- **FR-9:** Self-parity is consistency evidence, not independent vendor fidelity.
  SDK/consumer and differential evidence must be reported separately.
- **FR-10:** Scenario controls never add fictional public vendor endpoints or
  silently strengthen vendor idempotency, durability, or atomicity guarantees.
- **FR-11:** All new services use standard health/admin/isolation/clock/fault/journal
  controls and publish complete consumer exports and limitations.
- **FR-12:** Journal/metrics data excludes prompt bodies, credentials, and result
  content; fixtures use synthetic generic names and payloads.
- **FR-13:** Package delivery includes build, lint, typecheck, focused tests,
  contract/codegen, portability, pack, metadata, generated-doc, and root check gates.
- **FR-14:** The plan does not modify authentication/authorization logic. Synthetic
  scoped state and scripted denial observations are testing mechanisms; any future
  credential-enforcement implementation requires resolution of applicable policy.
- **FR-15:** Real-provider verification must not mutate operational resources.
  Missing credentials, platform, dependencies, or authorization remain reported gaps.

## 6. Non-goals

- Initiative source/test changes, scheduling fairness, duplicate-launch policy,
  supervisor fencing, publication journals, or intake graph implementation.
- A Hermes dispatcher/Kanban clone or a public mock of Initiative's internal APIs.
- A systemd service package in this implementation plan. Consumer assessment and
  native Linux evidence belong to the separate Initiative handoff; a future package
  needs its own approved requirements.
- Executing containers, builds, arbitrary commands, LLM inference, or a Git server.
- Proving OS isolation, cgroup enforcement, socket/process provenance, real App
  permissions, SQLite WAL/locking/backup correctness, or production readiness.
- Unrequested CI, authentication, dependency-version, or deployment changes.

## 7. Design and code-improvement constraints

Reuse `packages/service/core/src/runtime.ts`, `service.ts`, `collection.ts`,
`webhooks.ts` where relevant, and `packages/core/src/timeline.ts`. RxVortex is the
documented package-layout reference. Existing `packages/adapters/node/src/serve.ts`
streams HTTP response bodies but has no upgrade handler; keep Docker-specific
upgrade and Unix-socket ownership in the Docker package first.

For post-mutation response loss, specify how accepted state is captured even when
delivery rejects. Do not turn a network error into transaction rollback or make
every failed request commit automatically. Add targeted runtime regression evidence
before a shared change, and verify representative existing-provider behavior.

Close waiters and streams on cancellation/reset/shutdown with deterministic tests.
Prevent emissions across namespace/history changes. Use documented logical restart
controls, and never market in-memory checkpoint restoration as crash durability.

Hermes profile/session scoping and retention must follow pinned source. GitHub ref
semantics must follow the actual REST contract; consumer expected-target guards and
Git transport cannot be proved by a more powerful fictional mock endpoint.

## 8. Verification and completion

Use existing package commands from [AUTHORING_A_SERVICE.md](../docs/AUTHORING_A_SERVICE.md):
`bun run openapi:check`, `bun run generate`, `bun test`, `bun run typecheck`,
`bun run lint`, `bun run build`, `bun run pack:check`, and `bun run portability`.
Run them from the affected package once scaffolded. Root delivery uses
`bun run readme:sync`, `bun run llms:sync`, and `bun run check`. Branding and docs
metadata follow the existing authoring workflow; dependency/build-configuration
changes retain the repository's confirmation requirements.

No setup/install, implementation checks, or real-provider operations are part of
this drafting task. Future execution reports exactly which checks ran and which
oracle gates remain unavailable. Missing oracle results keep the corresponding
story incomplete rather than being translated into successful skips.

Success means all declared operation families have executable positive/negative
coverage, post-mutation failure scenarios retain correct state, deliberate
divergences are detected, package gates pass, and independent evidence supports
every advertised compatibility claim. No fixed coverage percentage or performance
target is assumed without a measurement requirement.

## 9. Open questions and handoff

1. Oracle selection resolved by user direction on 2026-09-27: use the current
   user-selected Engine without downgrading the host, record its exact version,
   and compare the declared v1.52 subset when within its supported API range.
   Desktop 4.92.0 supplies Engine 29.8.0; standalone latest 29.8.1 is distinct.
2. Which Hermes behaviors differ between current documentation and the pinned tag,
   and can an executor-only substitution preserve the required public lifecycle?
3. Which GitHub API-version header and operation subset should be advertised first?
4. Do post-mutation exceptions currently lose Timeline capture? Determine this with
   a sensitive regression before changing the shared runtime.
5. Which active-stream operations are explicitly excluded from history restoration?

`PLAN.md` is the ordered task source, not an execution authorization. Before
execution, load the installed `prepare-implementation` skill's shared execution
and staged-review contracts. Use a scoped committed worktree/branch and obtain
required implementation/commit and operational authorizations. Do not launch a
runner automatically. Execution history belongs in worktree-root `docs/progress.md`;
bounded reusable review knowledge belongs in `memory.json`. Drafting creates neither.

### Inspection provenance

Mockingbird was clean at `accea1e9` before these planning files. Initiative source
was sampled at HEAD `e3583b9` with substantial uncommitted/untracked work; that SHA
does not represent the inspected working tree. Relevant sampled consumers included
`docker_attach_handshake.py`, `docker_read_session.py`, `docker_endpoint.py`,
`maria_systemd_bus.py`, and `integrations/hermes/peer_http.py`. Their policy and
host-trust behavior is outside Mockingbird implementation scope. No claim is made
that those implementations or the new packages have passed runtime verification.
