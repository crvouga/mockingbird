# PRD and ordered handoff: Initiative mock integration and recovery tests

Status: draft requested September 25, 2026. **Owner: Avengers Initiative, not
Mockingbird.** This document is staged in Mockingbird solely because current
workspace instructions prohibit writes outside the project directory.

Intended destination:
`/Users/corysiebler/Repositories/avengers-initiative/tasks/prd-mock-integration-and-recovery.md`.
Transfer it from an authorized session in that repository after checking for an
existing target. It has **not** been written there. No story below is included in
Mockingbird's [archived plan](archive/infrastructure-orchestration-mocks/PLAN.md), and this handoff is not an active runner task source.

## 1. Overview

Extend Initiative's existing consumer contracts, test fixtures, and recovery
evidence as reusable Mockingbird Docker, Hermes peer-run, and GitHub REST packages
become available. Preserve Hermes as task/attempt authority and Initiative as owner
of scheduling, containment decisions, durable intake, and publication policy.

This supplements, rather than replaces, `tasks/prd-avengers-initiative.md`, the
Docker execution decision, and the active `PLAN.md`. Existing checked stories,
review history, Ralph assets, and uncommitted work must remain intact. Map these
deliverables to existing work before adding new execution entries; do not duplicate
already covered requirements or reset prior completion evidence.

Paths below are relative to Avengers Initiative after transfer. During drafting,
HEAD was `e3583b9` with substantial uncommitted/untracked work. That commit alone
does not describe the sampled source. Current behavior and prior verification must
be rechecked before implementation; this document reports no executed tests.

## 2. Goals

- Add missing multi-step recovery tests around existing adapters rather than
  replace the adapters or collapse their trust boundaries.
- Prove that uncertain execution never becomes a second writer or a premature
  claim/capacity release.
- Preserve separate task, attempt, peer run, intake, publication, and host identity.
- Adopt public protocol mocks without removing actual pinned-Hermes, Git, SQLite,
  Linux containment, or App-identity checks.
- Select a real expected-target publication mechanism rather than relying on
  stronger semantics invented by a mock.
- Evaluate reusable systemd support only after identifying remaining shared need.

## 3. Repository ownership and external dependencies

| Initiative owns | Mockingbird owns |
| --- | --- |
| Dispatcher/callback/CLI compatibility and consumer fakes | Public Hermes peer-run HTTP behavior |
| Supervisor, launch identity, fencing, maintenance, fairness accounting | Public Docker lifecycle and attach transport behavior |
| Host socket/procfs/cgroup provenance and native systemd tests | Deterministic synthetic Engine observations |
| Intake receipts and graph recovery | Peer-run idempotency and retention simulation |
| Broker approvals, journals, expected-ref transport, real Git | GitHub REST response/state simulation |
| Real App rules enforcement and SQLite backup/restore evidence | Provider contract/parity/package evidence |

Mockingbird's deliverables are named Docker, Hermes, and GitHub packages, each with
a version and support matrix. Pin the consumed release and record its contract
before adoption. A package's WIP/Ready label is not proof of Initiative deployment
acceptance. Initiative-local work can proceed before those packages are available;
only the corresponding adoption stories depend on them.

Use Context7 to retrieve current Docker, Hermes, GitHub, systemd, Git, and SQLite
documentation when working on those interfaces. Resolve the official library ID,
record retrieval/source/version, and compare to pinned upstream source and installed
versions. Current docs never replace exact Hermes `v2026.8.31` compatibility probes.
Avoid sharing credentials or private source content in documentation queries.

## 4. Individual deliverables

All implementation stories require **Tests pass** and **Typecheck passes** using
the project's real commands. Research-only stories require source/link checks and
typecheck consistency, not artificial tests. Dependencies below describe logical
order; reconcile them with the existing Initiative story graph before execution.

### AI-001: Inventory existing seams and missing scenarios

As a maintainer, I want source-backed coverage ownership so that new work extends
existing evidence without duplicating it.

Depends on: none. PRD mapping: US-004, US-010, US-025 and Docker design.

- [ ] Map Docker operations, Hermes callback/CLI and peer calls, systemd methods,
  containment observations, and publication requirements to source and tests.
- [ ] Distinguish existing unit doubles, pinned-runtime probes, native-host checks,
  and missing end-to-end cases; do not infer passing coverage from filenames.
- [ ] Inventory relevant dirty changes and verify the active plan before edits.
- [ ] Record exact runtime and mock package compatibility requirements.

### AI-002: Add reusable stateful recovery fixtures where missing

As a test author, I want independent process and transport observations so that
failures do not automatically erase execution state.

Depends on: AI-001. PRD mapping: US-009, US-010, US-025.

- [ ] Extend only demonstrated gaps in existing fixtures, using supported test seams.
- [ ] Model supervisor identity, execution identity, connection state, containment
  membership, and observation freshness independently.
- [ ] Provide deterministic clocks and failure points around creation, callbacks,
  receipt persistence, termination, and reconciliation.
- [ ] Retain genuine native identity checks; a fake observation is not host evidence.

### AI-003: Verify callback retries and exact successful-start accounting

As a dispatcher developer, I want retries after spawn to preserve one execution.

Depends on: AI-002. PRD mapping: US-009, US-010; FR-50, FR-52, FR-53.

- [ ] Exercise post-spawn `TypeError` and `ValueError`, both callback forms, and
  repeated board/task/run identity against the existing launch records.
- [ ] Reconcile ambiguous starts after simulated dispatcher restart; no second
  modeled writer starts and no successful start is charged twice.
- [ ] Genuine failed launches consume no successful-start debit; uncertain results
  block further accounting/admission until the existing policy resolves them.
- [ ] Add or retain burst, finite-pin, same-board, and review-start regression cases.

### AI-004: Strengthen pinned Hermes dispatcher and lifecycle contracts

As an integrator, I want real pinned-Hermes behavior tested independently of fakes.

Depends on: AI-001. PRD mapping: US-004, US-008, US-011, US-014.

- [ ] Reuse existing probes and disposable state for `dispatch_once`, callback
  retries, leadership, board/host/profile capacity, and fenced CLI transitions.
- [ ] Test missing/malformed/stale context and same-card implementation/review lineage.
- [ ] Assert `max_spawn=0` may perform maintenance; containment gates must precede
  operational recovery, and compatibility probes must not use operational boards.
- [ ] Preserve the import boundary at `integrations/hermes/`; do not modify Hermes
  tables or weaken production authorization to make fixtures pass.

### AI-005: Strengthen systemd and containment-observer fakes

As a supervisor developer, I want realistic partial and contradictory host evidence.

Depends on: AI-002. PRD mapping: US-010, US-024, US-025.

- [ ] Extend existing `maria_systemd_job`/bus and containment tests where gaps exist.
- [ ] Cover completion arriving during start, unrelated job signals, lost start
  replies, failed jobs, and retained manager-connection invalidation.
- [ ] Cover dead supervisor with live descendants, PID reuse, unknown membership,
  and delayed termination; no case infers retirement from PID disappearance alone.
- [ ] Keep native sd-bus transport/provenance verification as a separate real-host gate.

### AI-006: Adopt the Docker mock in consumer protocol tests

As a Docker adapter maintainer, I want the actual consumer exercised over the mock's
Unix socket and attach upgrade rather than handler-shaped Python return values.

Depends on: AI-001, AI-002 and a usable pinned Mockingbird Docker package.
PRD mapping: US-010, US-025; Docker launch/retirement decision.

- [ ] Add an explicit test-only server fixture with owned socket paths and cleanup.
- [ ] Exercise actual read/attach protocol code, partial headers/frames, accepted
  mutations with lost replies, and execution surviving transport loss.
- [ ] Preserve retained-session invalidation and no-reconnect behavior; do not
  bypass production checks to point privileged installed endpoints at a mock.
- [ ] Label simulated engine fields separately from UID/socket/procfs/cgroup evidence.

### AI-007: Adopt the Hermes peer mock in intake recovery tests

As an intake developer, I want submit/poll/retry behavior tested through real HTTP.

Depends on: AI-001, AI-002 and a usable pinned Mockingbird Hermes package.
PRD mapping: US-006, US-018, US-019, US-020.

- [ ] Exercise `PeerHttpClient` and durable attempt storage through the mock.
- [ ] Verify identical retry, conflicting key reuse, lost acknowledgements,
  interrupted terminal replay, replacement delivery, and upstream result expiry.
- [ ] Preserve enduring intake ID versus delivery-attempt key versus peer run ID;
  local retained terminal evidence survives expiry according to the consumer contract.
- [ ] Retain pinned-Hermes oracle tests; mock agreement alone is not upstream proof.

### AI-008: Select the real publication transport and expected-ref guard

As a broker designer, I want an enforceable target-head guard rather than a fictional
REST compare-and-swap operation.

Depends on: AI-001. PRD mapping: US-015, US-016; FR-54, FR-55.

- [ ] Use Context7 and primary docs to compare the actual candidate publication
  operations, their concurrency guarantees, and available expected-target guards.
- [ ] Record a design decision explaining REST versus Git transport ownership and
  how target drift prevents publishing a stale verified candidate.
- [ ] Explicitly record that ordinary REST ref PATCH's non-force fast-forward check
  is not an expected-old-SHA comparison; do not invent unsupported headers/fields.
- [ ] Keep default-branch protections, no-force-push rules, and approval ordering intact;
  an unavailable compliant mechanism remains a blocker.

### AI-009: Add broker reconciliation and integration test fixtures

As a broker developer, I want uncertain remote writes reconciled without duplicates.

Depends on: AI-008 and a usable pinned Mockingbird GitHub package.
PRD mapping: US-015, US-016.

- [ ] Use GitHub REST mocks for supported API calls and real disposable Git
  repositories/remotes for object, branch, worktree, and transport semantics.
- [ ] Cover remote success before local receipt, restart, existing-PR discovery,
  simultaneous integrations, moving target heads, and approval invalidation.
- [ ] Distinguish story-approved SHA from candidate/result SHA and verify the selected
  expected-ref mechanism instead of assuming mock ref semantics establish it.
- [ ] Do not treat client operation IDs as universal GitHub server idempotency keys.

### AI-010: Retain actual App-identity default-branch denial evidence

As an operator, I want actual repository enforcement verified separately from mocks.

Depends on: AI-008. PRD mapping: US-017, US-026.

- [ ] Define a separately authorized disposable-repository probe using the intended
  App identity and actual configured rules/bypass actors.
- [ ] Verify default-branch direct-write and supported merge paths are denied while
  permitted feature-branch operations succeed, under existing authorization policy.
- [ ] Missing credentials, repository support, or operational approval is an
  incomplete gate, not a passing mocked denial.
- [ ] No rule relaxation, production repository mutation, or permission broadening
  is part of this test work.

### AI-011: Add the combined duplicate-writer recovery regression

As a maintainer, I want the complete ambiguous-launch sequence tested across seams.

Depends on: AI-003, AI-004, AI-005, AI-006. PRD mapping: US-025, US-026.

- [ ] Exercise admission, accepted launch, lost response/callback error, dispatcher
  restart, surviving execution, repeated callback, and controlled retirement.
- [ ] Assert one writer, one successful-start debit, durable identity reconciliation,
  and no maintenance reclamation or successor admission during uncertainty.
- [ ] After verified retirement, permit only the supported successor/recovery path.
- [ ] Record which assertions use fakes versus real pinned Hermes; keep hostile-script
  and native containment tests separate rather than inferring their results.

### AI-012: Preserve and extend native rootless Docker/systemd gates

As an operator, I want actual confinement and lifecycle evidence on the target host.

Depends on: AI-005, AI-006; existing host/story prerequisites and explicit host approval.
PRD mapping: US-010, US-012, US-024, US-025; Docker backend decision.

- [ ] Compare the candidate rootless backend with retained Bubblewrap/systemd evidence.
- [ ] Verify effective mounts, private Git access, resource limits, network policy,
  cgroup membership, descendant survival, and retirement on the selected host.
- [ ] Test separately authorized engine outage/restart/live-restore, supervisor
  SIGKILL, and process-identity changes; mock stream closure does not prove retirement.
- [ ] Keep current assets and rollback evidence; no installation, activation,
  migration, or cleanup is implicitly authorized by this PRD.

### AI-013: Preserve real SQLite and backup/recovery evidence

As an operator, I want storage guarantees tested against the actual storage engine.

Depends on: AI-001 and existing backup/story prerequisites.
PRD mapping: US-007, US-023, US-026.

- [ ] Keep real SQLite WAL, lock contention, concurrent-process, online-backup, and
  crash/reopen tests; Mockingbird SQL result parity cannot replace them.
- [ ] Cover snapshot timestamps, Git objects/refs, intake and publication correlations,
  incomplete backup detection, and non-admitting/non-publishing restore reconciliation.
- [ ] Obtain required migration/restore authorization and record actual RPO/RTO evidence
  under existing requirements; unavailable remote services remain explicit blockers.

### AI-014: Assess a reusable systemd mock after consumer experience

As a maintainer, I want a reusable boundary demonstrated before proposing a package.

Depends on: AI-005, AI-012. PRD mapping: US-024, US-025.

- [ ] Inventory remaining repeated systemd fake behavior and at least the concrete
  consumer interfaces that would benefit from extraction.
- [ ] Use Context7 and installed-version docs to identify required D-Bus methods,
  signatures, properties, signals, ordering, connection lifetime, and oracle costs.
- [ ] Record a go/no-go recommendation, compatibility scope, transport design, and
  limits of simulation. Do not invent an HTTP systemd API.
- [ ] A go decision proposes a separate Mockingbird PRD; it neither adds a package
  to the current Mockingbird plan nor removes native-host tests.

## 5. Functional requirements and code improvements

- **AI-FR-1:** Test fixtures must represent process existence and observation
  availability independently; failures must not conveniently clear real obligations.
- **AI-FR-2:** Add stateful reusable fixtures only where duplication or missing
  cross-step coverage is demonstrated. Preserve sensitive existing assertions.
- **AI-FR-3:** Preserve durable identity and accounting at board/task/run boundaries
  across callback and process restarts; no second writer follows an unknown outcome.
- **AI-FR-4:** Keep compatibility probes disposable, isolated, and separate from
  operational boards. Only `integrations/hermes/` imports Hermes internals.
- **AI-FR-5:** Mock adoption uses explicit test seams and owned fixture lifetimes,
  not production endpoint rebinding, weakened identity checks, or configuration bypasses.
- **AI-FR-6:** Real Git, SQLite, pinned Hermes, native-host, and actual App-identity
  evidence remains authoritative for guarantees their respective mocks cannot prove.
- **AI-FR-7:** Publication tests use the selected real expected-target mechanism;
  remote successes with lost responses are reconciled before further writes.
- **AI-FR-8:** Current API research uses Context7 and versioned primary evidence;
  missing pinned-version coverage is explicit, not silently filled from main.
- **AI-FR-9:** No task here modifies authentication/authorization logic, provider
  fallback, operational permissions, or default-branch authority. Test-only simulated
  observations must not be marketed as enforcement.
- **AI-FR-10:** New requirements and work-item allocation must preserve the active
  Initiative plan, completed evidence, unrelated dirty work, and Ralph assets.

## 6. Verification and completion

The inspected README configures these existing commands; recheck them before use:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python scripts/check_architecture.py
ruff format --check src scripts tests
ruff check src scripts tests
mypy
```

Select focused tests first, then the repository's required gates. Do not install
tools, migrate fixtures, start native services, run inference, or write externally
merely to validate this plan. Honor the current repository's actual authorization
and platform requirements at execution time.

Completion requires sensitive regressions for the missing scenarios, honest
separation of mock and real-system evidence, and no weakened existing assertions.
The fixture being able to manufacture a safe result is not proof the runtime is
safe. Actual Linux/App/restore checks remain incomplete until authorized and run.

## 7. Ordered work allocation

| Stage | Deliverables | External prerequisite |
| --- | --- | --- |
| Inventory | AI-001 | Current Initiative working tree and plan inspection |
| Local fixture improvements | AI-002, AI-003, AI-004, AI-005 | Pinned Hermes environment for real compatibility checks |
| Docker adoption | AI-006 | Supported Mockingbird Docker release |
| Hermes adoption | AI-007 | Supported Mockingbird Hermes release |
| Publication design | AI-008 | Current provider documentation; independent of mock release |
| GitHub adoption | AI-009 | Selected publication transport and supported GitHub mock |
| Real enforcement | AI-010 | Scoped App-identity/disposable-repository authorization |
| Cross-component recovery | AI-011 | Local compatibility and Docker adoption |
| Native backend verification | AI-012 | Target host and approved operational scope |
| Storage verification | AI-013 | Existing backup prerequisites and approved test scope |
| Future systemd decision | AI-014 | Consumer/native evidence; separate future package approval |

These are individual handoff deliverables, not a replacement execution queue.
Resolve overlaps against existing stories before allocating work. No progress
journal, memory file, runner, or branch is created by this document.

## 8. Open questions

1. Which existing Initiative stories already own each acceptance criterion, and
   which are complete in the current dirty tree rather than committed HEAD?
2. Which exact Mockingbird release/API subsets satisfy each consumer without changes
   to its production trust model?
3. Which permitted publication transport supplies the required expected-target guard?
4. Which host/Engine/systemd versions and isolated oracle environments are approved?
5. Does systemd extraction offer enough reuse after the Docker direction is verified?
