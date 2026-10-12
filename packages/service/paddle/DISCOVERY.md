# @crvouga/mockingbird-service-paddle discovery

This is the installed-package index for coding agents and tooling. All relative links resolve
inside `node_modules/@crvouga/mockingbird-service-paddle/`; no repository checkout is needed to discover the emulator's
supported surface or documented behavior.

## Capability and behavior sources

| Question | Authoritative file | What it contains |
| --- | --- | --- |
| Behaviour and integration | [`README.md`](README.md) | Routes, state transitions, auth, webhooks, controls, presets and deliberate omissions. |
| Exact capabilities | [`SUPPORT.md`](SUPPORT.md) | Supported, unsupported and parity-covered operations or commands, including reasons for gaps. |
| Wire contract | [`openapi.yaml`](openapi.yaml) | Machine-readable paths, methods, schemas, responses and parity annotations. |
| Public API | [`dist/index.d.ts`](dist/index.d.ts) | The installed package's exact TypeScript exports and signatures. |
| Package metadata | [`package.json`](package.json) | Runtime/entry-point claims, vendor links, parity scope/tier and `mockingbird.discovery`. |

Read these together: the contract/capability matrix says *what* is available, while the README
defines stateful behavior, lifecycle rules, test controls, and intentional oracle differences.
If prose and an executable surface disagree, report a parity mismatch instead of adding a
consumer-side workaround.

## Parity and oracle

- Declared parity surface: **Billing, subscriptions, and webhooks**.
- Parity tier: **cold** (the repository controls when live checks run).
- Oracle: **Live vendor API or sandbox**.
- Repository command: `bun run parity:service -- paddle`.
- Evidence model: Run from a Mockingbird checkout; credentials come only from .env.local or GitHub Actions secrets. Missing credentials exit 2.

The npm package contains evidence summaries and the exact contract, not credentials or the
repository-only parity harness. Self-parity/property and acceptance tests run in the Mockingbird
repository; live parity is an additional oracle check, not a substitute for the packaged matrix.

## Runtime introspection

- `GET /__admin/health`
- `GET /__admin`
- `GET /__admin/controls`
- `GET /__admin/state`
- `GET /__admin/requests`
- `GET /__admin/metrics`
- `GET /__admin/faults/presets`
- `GET /__admin/ui`

For HTTP services, use `x-mockingbird-namespace` (or the documented credential/path carrier) so
parallel tests do not share state. Admin state, journal, metrics and fault-preset endpoints are
designed for assertions and diagnosis by consuming test suites.

## Admin controls

Every HTTP emulator takes the same controls, and each means the same thing at boot
(`createRuntime({ adminControls })`, `serve --admin-controls`), over `/__admin`, and in a request header:

| Control | Admin API | Request header | Interface |
| --- | --- | --- | --- |
| Isolate state by key | `GET /__admin/namespaces` | `x-mockingbird-namespace: <key>` | [Namespaces](https://mockingbird.chrisvouga.dev/docs/admin-controls/namespaces) |
| Reset to boot | `POST /__admin/reset` | `x-mockingbird-reset: true` | [Reset](https://mockingbird.chrisvouga.dev/docs/admin-controls/reset) |
| Snapshot and restore | `POST /__admin/snapshots`, `POST /__admin/snapshots/<id>/restore` | `x-mockingbird-snapshot: <name>`, `x-mockingbird-restore: <name>` | [Snapshot and restore](https://mockingbird.chrisvouga.dev/docs/admin-controls/snapshot-and-restore) |
| Move the clock | `POST /__admin/clock` | `x-mockingbird-time: <instant>`, `x-mockingbird-advance: <duration>` | [Clock](https://mockingbird.chrisvouga.dev/docs/admin-controls/clock) |
| Read or branch from old state | `GET /__admin/timeline` | `x-mockingbird-at: <checkpoint>`, `x-mockingbird-branch: <name>` | [Checkpoints and branches](https://mockingbird.chrisvouga.dev/docs/admin-controls/checkpoints-and-branches) |
| Inject a fault | `POST /__admin/faults` | `x-mockingbird-fault: <fault>` | [Faults](https://mockingbird.chrisvouga.dev/docs/admin-controls/faults) |
| Latency and timeouts | `PUT /__admin/latency` | `x-mockingbird-delay: <duration>`, `x-mockingbird-timeout: <duration>` | [Latency and timeouts](https://mockingbird.chrisvouga.dev/docs/admin-controls/latency-and-timeouts) |
| Replay from a seed | `PUT /__admin/controls` | `x-mockingbird-seed: <seed>` | [Seed and determinism](https://mockingbird.chrisvouga.dev/docs/admin-controls/seed-and-determinism) |
| See what happened | `GET /__admin/requests`, `GET /__admin/state` | | [Journal, metrics and state](https://mockingbird.chrisvouga.dev/docs/admin-controls/journal-and-state) |

`GET /__admin` lists every route and header with a one-line summary, and `GET /__admin/controls`
is the namespace's current control document. The same seed and the same requests give the same
bytes. Setting controls as an emulator starts is [Boot](https://mockingbird.chrisvouga.dev/docs/admin-controls/boot); every route and header is in
the [Reference](https://mockingbird.chrisvouga.dev/docs/admin-controls/reference). The full guide: <https://mockingbird.chrisvouga.dev/docs/admin-controls>.

## Report a mismatch or missing capability

Follow the [agent reporting contract](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md). Include package version,
operation/command, a minimal redacted request, actual emulator result, expected oracle result or vendor
documentation, and whether the mismatch appears in the matrix. Never include keys, tokens,
customer data, prompts, PHI, card data, or unredacted recordings.

Service key: `paddle`.
