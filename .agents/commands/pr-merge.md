---
name: pr-merge
description: Take the current branch all the way to a merged PR (commit, publish, sync with main, resolve conflicts, open the PR, fix every failing check — CI and third-party like GitGuardian — then merge automatically).
---

# /pr-merge

<!-- Canonical file: .agents/commands/pr-merge.md. Every agent harness symlinks here
     (bun run agents:sync) — edit this file, never a link. -->

Drive the current branch from local work-in-progress to a PR **merged into `main`**. All mechanical
git/GitHub work is done by `bun scripts/pr-merge.ts`; your job is the judgment: commit message,
conflict resolution, PR title/body, and root-cause fixes for every failing check.

The job is done only when the PR is merged. Do not stop at "CI is green" or "only a non-required
check is failing", and do not ask the user before merging: once the branch is pushed, synced with
`main`, and **every** check on the PR has passed (required or not), merge it.

Run it as `bun run pr:merge <command>` (or `bun scripts/pr-merge.ts <command>`). Every command except
`logs` prints exactly one JSON object on stdout — parse that; never scrape raw `git`/`gh` text.
The base is always `main` (the trunk). Pass `--base main` or omit it — the script rejects any other
base with a usage error, and `pr` always opens the PR against `main`.

Stop and report to the user only if `gh auth status` fails, if a command returns a usage error
(exit 2) you cannot resolve, or if a failure genuinely needs a human (a missing secret or token —
report the key name and Vault path, never a value; OIDC/infrastructure; an external outage; a real
leaked credential that must be rotated).

## Fast path

After committing local changes and running the relevant local checks, use one command:

```
bun run pr:merge advance --timeout 1800
```

It syncs both the remote head and `origin/main`, publishes, creates a PR if needed using the
non-merge commit subjects, marks a draft ready, waits for every check, inspects review feedback,
and merges. It stops with one JSON object at the first blocker. Fix the reported conflict, check,
or review concern and rerun. Pass `--title` and `--body-file` to control a new PR's text. If the
output contains general PR comments, read and address them, then rerun with
`--comments-reviewed`. Confirm `merged: true`; a pending merge is not completion. The detailed
commands below are for investigating and fixing blockers.

## 1. Preflight

```
bun run pr:merge status
```

Require `ok: true`; if not, stop and report the raw output. Require `gh auth status` to succeed — no
PR, checks, or ruleset work is possible without it. Note `base` and `branch` from the status.

## 2. Merge gate (repo settings + required checks)

```
bun run pr:merge repo
bun run pr:merge ruleset
```

If either reports `ok: false`, apply the canonical settings and re-verify:

```
bun run pr:merge repo --apply
bun run pr:merge ruleset --apply
bun run pr:merge repo
bun run pr:merge ruleset
```

If a write fails from a permissions error (`repo settings writes require admin` /
`ruleset writes require repo admin`), report the `drift` and continue with the rest of the flow; do
not stop.

## 3. Commit and publish

```
bun run pr:merge context
```

From the actual `commits`/`files`/`diffstat` (never invent scope), write one Conventional Commit
message: a type from `feat`/`fix`/`chore`/`docs`/`test`/`refactor`/`ci`/`build`/`perf`/`style`, header at
most 120 characters, no invented scope. Write it to a temp file and commit:

```
bun run pr:merge commit --message-file /tmp/commit-msg.txt
```

If the result has `step: "commitlint"`, fix the message and retry (at most 3 attempts, then report).
If nothing is staged, `commit` reports `committed: false, reason: "nothing-to-commit"` — that is fine
when the work is already committed.

If the tip commit is already pushed and only its message is wrong, amend it instead of adding a new
commit — `bun run pr:merge commit --amend --message-file …` then
`bun run pr:merge publish --force-with-lease` — and say so in the PR body.

**Before the first publish, review the unpushed diff for anything credential-shaped** — API keys,
tokens, account SIDs, private keys, `user`/`password` pairs, connection strings — including test
fixtures. GitHub push protection and GitGuardian scan every commit, and once a commit is pushed its
contents cannot be scrubbed without a force-push. Unpushed commits can still be fixed locally: amend
or fold the fix into the commit that introduced it (`git commit --fixup <sha>` then
`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main`), then publish. Real secrets never go
in the repo (they live in Vault); test values should be obviously fake and not look like real
credentials.

Before publishing, run the CI graph locally — turbo caches it, so only what changed re-runs:

```
bun run check
```

Fix any failure at its root cause (see step 6's rules) and commit the fix before continuing.

Publish the branch:

```
bun run pr:merge publish
```

If the push is rejected by push protection, the output names each flagged file and commit. The
commits are not on the remote yet, so remove the value from history locally as above (never use the
"allow secret" bypass URL for a real secret), then publish again.

## 4. Sync with the base branch

```
bun run pr:merge sync
```

- `alreadyUpToDate: true` or `merged: true` (exit 0) → continue. If `pushNeeded: true`, `publish` again.
- `sync` fetches and merges remote head changes before `origin/main`, preserving work from another
  workspace without a force push.
- exit 3 (`step: "merge"`) → for each path in `conflicts`: read both sides (`git diff <path>`), resolve by
  hand preserving **both** intents (never take one side wholesale), `git add <path>`, then
  `bun run pr:merge sync --continue`. If the merge commit lands, `publish` again.
- exit 2 (`worktree not clean`) → commit first (step 3), then re-run `sync`.

Repeat until `sync` reports `alreadyUpToDate` or `merged` with no conflicts.

## 5. Open the PR

```
bun run pr:merge pr
```

If `created: false`, the PR already exists — do nothing. Otherwise, generate a Conventional-Commits
title (CI's `action-semantic-pull-request` enforces it) and a Markdown body with a `## Summary`
(2–4 bullets drawn from the `context` commits/files) and a `## Test plan` (the exact commands you ran).
Write the body to a temp file outside the repo, then:

```
bun run pr:merge pr --title "<conventional title>" --body-file /tmp/pr-body.md
```

If the PR is a draft, mark it ready — this command always ends in a merge:

```
bun run pr:merge pr --ready
```

## 6. Loop every check to green

```
bun run pr:merge checks
```

`checks` covers **every** check on the PR — the required `Required` job, the rest of CI, and
third-party apps such as GitGuardian. A failing non-required check still blocks this command: fix it
like any other.

- exit 4 (`pending`/`timedOut`) → not done; run `checks` again.
- exit 1 (`failing`) → for each failing check:

  ```
  bun run pr:merge logs --name "<check name>"
  ```

  For a GitHub Actions check this prints the failing log; for a third-party check it prints that
  app's check-run report (its findings and links). Read the failing lines, find the root cause, and
  fix it in-repo. Never weaken, skip, or disable a check; never edit workflow files to make a check
  pass; never delete tests. Reproduce locally with the closest replica (`bun run check:format`,
  `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check`, or `bun run check:full` for
  the full CI replica), then repeat step 3's `commit` + `publish` and re-run `checks`.

- A check that failed for a transient reason (runner crash, network blip, an app that timed out) —
  confirm from its log that nothing in the repo caused it, then re-run it instead of pushing:

  ```
  bun run pr:merge rerun --name "<check name>"
  ```

- Repeat until `checks` exits 0. If the same check fails twice after a fix attempt, stop guessing:
  read the full log and reproduce locally before the next push. If a failure is clearly not fixable
  in-repo, stop and report the check name, link, and log excerpt.

### GitGuardian Security Checks

GitGuardian scans **every commit in the PR**, not just the head, so removing a value in a later
commit does not clear an incident raised on an earlier one. List what it found:

```
bun run pr:merge guardian
```

Each incident has its `id`, `detector`, `commit`, `file`, `line`, and whether the commit is already
`pushed`. Open the file at that line and decide what the value is:

1. **A real credential** (it works, or might, against a real service): remove it from the code and
   read it from the environment instead (Vault — see `docs/SECRETS.md`). Then **stop and tell the
   user** the incident link and that the credential must be rotated — rotation is theirs to do,
   and a rotated secret is the only real fix once it has been pushed. Never mark a real
   credential as ignored.
2. **A test fixture or false positive** (a made-up value that only a mock accepts):
   - Change the fixture so it no longer looks like a credential, and commit that fix.
   - If the flagged commit is **not pushed**, fold the fix into it (step 3) so the value never
     reaches the remote.
   - If it **is pushed**, the history still holds the value, so resolve the incident in
     GitGuardian as not a leak, then re-run the check:

     ```
     bun scripts/vault-run.ts -- bun scripts/pr-merge.ts guardian ignore --incident <id> --reason test_credential
     bun run pr:merge rerun --name "GitGuardian Security Checks"
     bun run pr:merge checks
     ```

     Use `--reason false_positive` when the value is not a secret at all (for example a hash or
     an ID the detector mistook for one). `guardian ignore` needs `GITGUARDIAN_API_KEY` (a
     GitGuardian API token with `incidents:write`) in Vault `secret/personal/dev`. If it
     reports `step: "guardian-auth"`, stop and tell the user either to add that key or to mark
     the incident as a test credential themselves at its dashboard link. Then continue from the
     `rerun`.

Never force-push to scrub a pushed commit (see Rules), and never use a secret-scanning bypass for a
real credential.

## Review feedback

```
bun run pr:merge comments
```

The JSON lists unresolved review threads and recent general comments. Read each concern, make a
code change or explain why no change is needed, and reply to the thread with
`bun run pr:merge reply --thread <id> --body-file <file>`. Then run
`bun run pr:merge resolve --thread <id>` only after its concern is addressed. Reply to a general
comment with `gh pr comment <number> --body-file <file>` when appropriate. Rerun `comments` until
threads are resolved. The merge gate checks unresolved threads and changes-requested reviews.

## 7. Merge

When `checks` exits 0, merge. `merge` re-verifies everything first:
- the PR is open and not a draft;
- the worktree is clean and pushed;
- the branch is not behind `origin/main`;
- every check on the PR passed or was skipped;
- GitHub reports the PR mergeable.

Only then does it land the PR as a merge commit.

```
bun run pr:merge merge
```

- exit 0 (`merged: true`) → done; go to step 8.
- exit 4 (`pending`) → checks or GitHub's mergeability are still settling; run `checks`, then `merge`
  again.
- exit 1 (`step: "merge-gate"`) → each entry in `blockers` says what to do: commit/publish, `sync`
  (then `publish` and `checks` again), fix a failing check (step 6), or `pr --ready`. Handle it and
  come back here.

`bun run pr:merge merge --dry-run` runs the same gate without merging.

## 8. Completion

```
bun run pr:merge status
```

Report exactly: branch, PR number and URL, base branch, the PR `state` (must be `MERGED`), every
check name with its bucket, and the required contexts. Success requires a merged PR whose checks all
passed — never report success on an open PR, or on a partial, queued, or filtered run.

## Rules

- Never `git push --force`; only `--force-with-lease`, and only to fix an unpushed-tip message via `--amend`.
- Never push the base branch.
- Never `git reset --hard` or `git checkout .` to discard work.
- Never disable or bypass a check, and never merge around one — including non-required checks.
- Keep each fix minimal and focused on the failing check's root cause.
- Use the script's JSON instead of raw `git`/`gh` output.
- Do not paste full diffs or full CI logs into chat — quote only the failing lines.
- Never print, invent, or commit secret values; name the missing key and its Vault path instead.
- Never target a base other than `main`.
- Only merge commits land on `main` — never squash or rebase.
