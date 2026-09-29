# Bounded GitHub oracle (repository checkout only)

This opt-in script compares the nine supported REST operations against one
explicitly owned, disposable, nonempty repository at API version2026-03-10.
It is not part of default tests or the published portable package. Do not run it
against a production/shared repository. Stop other actors and automation that
could modify its uniquely named fixture branches during the run.

The first authorized live run on 2026-09-29 compared all nine operations with
11 of 12 comparisons matching. Clearing a PR body exposed a mismatch: GitHub
returns null while the mock returned an empty string. A local regression and
repair cover that observation. A separately authorized verification run
`87b2f906-12fa-4f92-a373-09b7c4d85a21` then matched all 12 comparisons across
the nine operations, including the repaired body behavior.
Both runs closed their PR and deleted both fixture branches. Local tests also exercise
scope gates, transport boundaries and cleanup with a synthetic transport;
those tests alone do not prove GitHub compatibility.

## Prepare a reviewable scope

Build the package first with `bun run --cwd packages/service/github build`.
Choose a fresh UUIDv4 and the disposable owner/repo explicitly:

```sh
node packages/service/github/oracle/run.mjs --plan \
  --repository=OWNER/DISPOSABLE_REPO --run-id=UUID_V4 \
  --api-version=2026-03-10 \
  --operations=repos/get,git/get-ref,git/list-matching-refs,git/create-ref,git/update-ref,pulls/create,pulls/get,pulls/list,pulls/update
```

Planning makes no requests and reads no credentials. It writes a new plan under
`.mockingbird/github-oracle/<run-id>/plan.json` and prints its SHA256 digest.
The operation subset is deliberately fixed to these nine; unrecognized or partial
subsets fail instead of silently expanding their fixture requirements.

The manifest covers these actions:

- Read repository identity and default-branch commit/tree, without changing it.
- Confirm both unique fixture branch names are absent.
- Create two trees with inline synthetic file content (GitHub also creates blobs)
  and two synthetic-authored commits based on that existing tree.
- Create `mockingbird-oracle/<run-id>/base` and `/head`. Advance only the owned head
  with `force: false`; attempt an older-SHA update to compare its rejection.
- Create one PR from owned head to owned base; compare duplicate-create rejection,
  get/list observations and a title/body edit. No merge, review or default-branch
  update occurs. GitHub may send notifications or trigger workflows/webhooks.
- Close the acknowledged PR and delete only acknowledged fixture refs after
  checking the PR identity and current branch tips. If identities/tips changed or
  a write acknowledgement is uncertain, preserve affected resources and report
  them for manual reconciliation. A prefix alone is not ownership proof.

The budget is48requests, with no automatic retry. Parsed HTTP5xx write responses
are uncertain too: an error response does not prove that no mutation occurred.
A response-loss or other failure
can leave partially created resources. GitHub cannot delete PR history through this
workflow; the closed PR and unreachable blobs/trees/commits remain. Ref deletion
has no atomic conditional API: exclusive use of the disposable fixture namespace
is required, and concurrent interference remains a limitation.

## Execute only after separate authorization

Approve the exact manifest digest, all fixture writes, notifications/workflow
side effects and cleanup separately from ordinary local implementation approval.
Provide `MOCKINGBIRD_GITHUB_TOKEN` through the approved local environment or
repository secret workflow; never put it in a command, plan, report or committed
file. The token needs the repository permissions for the listed operations.
Missing environment credentials are reported by key name only. Alternatively,
explicitly select `--gh-auth` to use your authenticated GitHub CLI. The script
captures `gh auth token --hostname github.com` directly in process memory after
scope validation; it never prints or saves the token. Authentication errors are
sanitized. It does not change token permissions or authentication policy.

```sh
node packages/service/github/oracle/run.mjs --execute --run-id=UUID_V4 \
  --confirm=REVIEWED_PLAN_SHA256 --allow-writes --allow-notifications --allow-cleanup
```

Those flags acknowledge previously granted authorization; they are not a substitute
for obtaining it. The script uses only `https://api.github.com`, refuses redirects,
limits each request to30seconds and records attempted requests before sending.
It will not overwrite a previous report or retry a partial run. Inspect existing
receipts before planning another run.

Reports contain statuses, version/request IDs, comparison booleans, resource
receipts and cleanup results. They omit authorization headers, response bodies,
raw exception messages and commit author data. Version confirmation is required.
Comparisons project the declared identity/state/ref/PR fields and selected errors;
unstable IDs/timestamps, full GitHub schema, multi-page live data, access-control
policy, rate quotas and real network-loss behavior are not claimed by this oracle.

Run offline verification with:

```sh
node --test packages/service/github/oracle/oracle.test.mjs
```
