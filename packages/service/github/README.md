# @crvouga/mockingbird-service-github

WIP GitHub REST mock targeting `X-GitHub-Api-Version: 2026-03-10`.
Repository observations, commit-backed references, and same-repository pull-request
create/get/list/update are implemented. Unsupported features return mock-only 501.
[API_EVIDENCE.md](API_EVIDENCE.md) pins the source and distinguishes research from
runtime verification. [SUPPORT.md](SUPPORT.md) is generated from the contract.

## Install

```sh
bun add @crvouga/mockingbird-service-github
```

## API

The portable entry exports `GitHubAPI`, `createRuntime`, `GITHUB_NAMESPACE`,
`GITHUB_API_VERSION`, `document`, `operationIds`, and `supportedOperationIds`.
Types include `GitHubAPIOptions`, `GitHubRuntime`, `GitHubRuntimeOptions`,
`Repository`, `Commit`, `PullRequest`, `OperationId`, and `SupportedOperationId`.
The Node-only `/server` entry exports `createServer`, `DEFAULT_PORT`, `serveTarget`,
`GitHubServerOptions`, and `GitHubServer`. The executable is `mockingbird-github`.

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-github"

const github = createRuntime({ seed: 42 })
await github.fetch(new Request("http://github.mock/__admin/github/repositories", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    owner: "synthetic-org", name: "example", default_branch: "main",
    commits: [
      { sha: "a".repeat(40), parents: [] },
      { sha: "b".repeat(40), parents: ["a".repeat(40)] },
    ],
    branches: { main: "a".repeat(40) },
  }),
}))
const response = await github.fetch(new Request("http://github.mock/repos/synthetic-org/example"))
console.log(await response.json())

// Continue with the same runtime to publish a synthetic branch and PR.
const repo = "http://github.mock/repos/synthetic-org/example"
const send = (path: string, method = "GET", body?: unknown) => github.fetch(
  new Request(`${repo}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }),
)
const branch = await send("/git/refs", "POST", {
  ref: "refs/heads/topic", sha: "b".repeat(40),
})
console.log(branch.status) // 201
const created = await send("/pulls", "POST", {
  title: "Synthetic change", head: "topic", base: "main", body: "Description",
})
const pr = await created.json()
console.log(created.status, pr.number) // 201, 1
const lookup = await send("/pulls?head=synthetic-org%3Atopic&base=main&state=open")
console.log((await lookup.json())[0].number === pr.number) // true
const edited = await send(`/pulls/${pr.number}`, "PATCH", { body: "" })
console.log((await edited.json()).body === null) // true
```

All requests above stay inside the local Fetch runtime. The branch target must
already exist in the synthetic commit graph; this is not a Git push.

`createRuntime` adds health, namespaces, clock, scoped faults, redacted request
journal and shared Timeline. Select a namespace with `x-mockingbird-namespace`
or `/ns/<name>/...` consistently on seed and provider requests. Reset removes
repository, owner, ancestry and branch state in that namespace; diagnostic history
and fault settings retain their shared runtime lifetimes. Checkpoints restore
all stored provider state through the shared Timeline.

`GitHubAPI` is the portable provider-only Fetch/Hono entry; `createServer` from
`@crvouga/mockingbird-service-github/server` exposes Node HTTP and returns a
`close` function. Programmatic servers default to an ephemeral loopback port.
The CLI is `mockingbird-github serve --port 8828`.

## Synthetic setup and boundaries

`POST /__admin/github/repositories` accepts owner/name, optional `private` and
`default_branch`, a `commits` array of lowercase 40-hex SHA/parents records and a
`branches` map of branch names to seeded SHAs. Omitted commits/branches create an
empty synthetic repository. Every parent and branch target must be seeded; cycles,
duplicates and an absent default branch in a nonempty branch map are rejected.
Validation completes before mutation; existing repositories cannot be overwritten
by this control. Use a fresh namespace or reset for a different fixture.
These are mock fixture constraints, not GitHub REST request rules.

Seeds create organization owners only. Same-owner repositories share owner
identity. Repository lookup is case-insensitive; branch names preserve case.
Only identity, ownership, visibility, default branch, URLs and timestamps are
returned; repository settings, statistics, permissions and full upstream response
coverage are not claimed. Missing repositories return a provider-shaped 404.
No credential-based namespace mapping or authorization policy is implemented.

The selected API version is returned in `x-github-api-version-selected`. Omitting
the request header selects this mock's 2026-03-10 contract, unlike GitHub's current
2022-11-28 default. Other versions return mock-only 501, not a claimed provider
error. This is an explicit single-version test double.

No Git transport, real commit creation, token issuance, GitHub App identity,
branch protection, repository rules, merge execution or outgoing notification is
provided. Seeded ancestry does not prove a real repository's contents. No
expected-old-SHA or universal pull-request idempotency guarantee is added.
Use synthetic fixture names only; journal records omit bodies and credential/query
values. Package tests require no GitHub account or network service.

## References

`GET /repos/{owner}/{repo}/git/ref/heads/topic/nested` reads an exact ref;
`GET .../git/matching-refs/heads/topic` returns prefix matches. Omit the suffix
(with or without a trailing slash) to list all synthetic refs. Names are case-sensitive;
owner/repository lookup remains case-insensitive. Matching refs are sorted by full name.

Create with `POST .../git/refs` and `{ "ref": "refs/heads/topic", "sha": "<seeded SHA>" }`.
Update with `PATCH .../git/refs/heads/topic` and `{ "sha": "<seeded SHA>" }`.
Default `force: false` requires ancestry from the head current at mutation time.
`force: true` permits a synthetic non-fast-forward update; it never invokes Git or
GitHub. Unknown fields do not confer an expected-old-SHA lease or idempotency.

Only commit-backed references are modeled; annotated tag objects and provider-managed
pull refs are unsupported. The bounded oracle compared successful ref operations and
one non-fast-forward422 envelope. Other error wording, condition/status mapping and
validation precedence remain provisional; see API_EVIDENCE.md.


## Pull requests

Create with `POST /repos/{owner}/{repo}/pulls` and a title, head branch and base branch:
`{ "title": "Synthetic change", "head": "topic", "base": "main" }`.
Both branches must exist and the head must contain seeded ancestry absent from the
base. An owner-qualified same-repository head is accepted; cross-repository heads
and issue conversion are explicit501 limitations. No notifications are sent.

Read `GET .../pulls/{number}` or list `GET .../pulls`. List supports state
(`open` default, `closed`, `all`), `head=owner:branch`, base, created/updated sorting,
direction, page (default1) and per_page (default30, clamped100). Follow Link relations;
filters and explicit namespace header/path selections survive pagination. Continue
sending shared history/branch headers if you selected a Timeline branch. Popularity
and long-running sorts return501 because comments/activity are not modeled.

Update title, body, base, state and maintainer_can_modify with `PATCH .../pulls/{number}`.
An empty body string clears the description and returns null. Head is not an update field. Numbers
are repository-scoped; id/node_id stay stable. The reduced response includes
head/base names, repository identity and SHAs. Open PRs resolve current branch tips;
closed PRs retain the last captured tips until explicitly updated. PR timestamps
track create/update calls, not background provider events. Mergeability and merge
commit SHA stay null; merged stays false. Author identity, comments, labels,
reviews, merge execution and provider event propagation are not modeled.

An open PR for the same head/base yields422 with a PullRequest/custom validation
error. Consumer-private operation IDs and Idempotency-Key never deduplicate creates.
If the response is lost, list by head/base across pages, then retrieve the matching
number; retrying create can yield the duplicate error. The bounded live oracle
confirmed this same-repository duplicate envelope at API version2026-03-10.
See API_EVIDENCE.md for untested cases and error-precedence gaps.

## Publication fault scenarios

Activate a namespace-scoped preset through `POST /__admin/faults` with
`{ "preset": "github_pr_create_accepted_drop" }`. List presets with
`GET /__admin/faults/presets`. Existing shared fault overrides can narrow an
operation/path, change a response or retire a scenario after a chosen count.

- `github_pr_create_accepted_drop`, `github_pr_update_accepted_drop`,
  `github_ref_create_accepted_drop`, `github_ref_update_accepted_drop`: the next
  matching request reaches normal validation. Only a successful mutation is
  accepted, checkpointed and followed by a dropped response. Invalid requests
  retain their ordinary errors and consume that one-shot rule. In-process Fetch
  rejects with TypeError; the Node HTTP adapter closes the connection. Recover
  through provider reads; retrying a create may return a duplicate error.
- `github_unavailable`: one503 before mutation for each of the four write operations.
- `github_denied`: one403 with a scripted integration-denied message per write
  operation. This does not inspect credentials or evaluate permissions/rules.
- `github_rate_limited`: one secondary-limit429 per write operation, Retry-After60
  and a synthetic remaining count1. Static headers exercise client backoff; there
  is no automatic quota engine, timer-driven expiry, or claim that every GitHub
  rate limit has this status/message/header combination.

Accepted write journal entries record `accepted`, checkpoint and ref/PR-number
metadata even when response status is0. Bodies are omitted. Fault settings follow
shared runtime lifetime and are not rewound by provider-state checkout.

To model a separate intervening actor, call `POST /__admin/github/refs/move` with
`{ "owner": "synthetic-org", "repo": "example", "ref": "refs/heads/topic", "sha": "<seeded SHA>" }`
between a client's read and write. This mock-only control requires an existing
branch and a seeded fast-forward target, creates a separate checkpoint, and
returns `simulated: true`. It cannot create refs, force rewrites or mutate another
namespace. Invalid controls leave state/history unchanged. Subsequent writes use
the current tip's ancestry; a stale observation alone is not grounds for rejection.
This control models interleaving, not atomic publication or real branch enforcement.

## Local contract verification

`bun test` includes seeded self-parity for all nine operations and successful
per-operation response checks. A deliberately divergent, schema-valid repository
observation must fail the parity comparator. These are two isolated mock instances;
self-parity is not evidence that GitHub matches this implementation.

`test/node-consumer.mjs` uses native Node HTTP and literal public contracts against
the built local server. It recovers a PR after socket loss, observes duplicates
without idempotency, follows pagination over31PRs, checks intervening ref movement
without CAS, and schedules a retry from Retry-After using a logical test clock.
It imports no provider handlers or state helpers. Run the package build before
running this consumer directly. It creates only local fixture resources.

Parity metadata enables all nine operations; the four writes are marked unsafe
and require explicit inclusion. Real-provider comparisons still require the
separate bounded oracle and explicit disposable-resource authorization. WIP status
remains until independent compatibility evidence supports a stronger claim.

## Bounded live evidence and publication limits

The separately approved 2026-09-29 oracle verification matched12comparisons across
all nine operations after repairing the empty-body update mismatch found in its
first run. Each run closed its fixture PR and deleted its two unchanged fixture
branches; closed PR history and Git objects remain. The runner is available only
in the repository checkout; see the
[oracle guide](https://github.com/crvouga/mockingbird/tree/main/packages/service/github/oracle).
It requires a reviewed manifest and explicit writes/notifications/cleanup approval,
plus `MOCKINGBIRD_GITHUB_TOKEN` or explicitly selected authenticated `gh` usage.
Ordinary package tests never invoke it.

This evidence covers selected identity/state/ref/PR fields and two error cases.
It does not establish complete upstream response schemas, all validation precedence,
live multi-page behavior, real rate quotas or real network-loss guarantees. The
package remains **WIP**. Scripted denied responses do not prove GitHub App identity,
token permissions, branch protection or rulesets. There is no Git transport or
token issuance, no expected-old-SHA compare-and-swap, and no atomic transaction
covering ref movement and PR publication. Consumer reconciliation policy and
cross-component Initiative acceptance remain outside this mock.
