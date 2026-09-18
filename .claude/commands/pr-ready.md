---
description: Take the current branch to an open PR with every check green (commit, publish, sync with main, resolve conflicts, create PR, loop CI to green).
---

# /pr-ready

Drive the current branch from local work-in-progress to an open, fully green PR. All mechanical
git/GitHub work is done by `bun scripts/pr-ready.ts`; your job is the judgment: commit message,
conflict resolution, PR title/body, and CI root-cause fixes.

Run it as `bun run pr:ready <command>` (or `bun scripts/pr-ready.ts <command>`). Every command except
`logs` prints exactly one JSON object on stdout — parse that; never scrape raw `git`/`gh` text.
`$ARGUMENTS` is an optional base branch; when present, pass it as `--base <value>` to every call
(omit it and the script resolves the base from `origin/HEAD`, defaulting to `main`).

Stop and report to the user if `gh auth status` fails, if a command returns a usage error (exit 2)
you cannot resolve, or if a CI failure is not fixable in-repo (missing secret/OIDC/infrastructure,
external outage).

## 1. Preflight

```
bun run pr:ready status
```

Require `ok: true`; if not, stop and report the raw output. Require `gh auth status` to succeed — no
PR, checks, or ruleset work is possible without it. Note `base` and `branch` from the status.

## 2. Merge gate (required checks configured)

```
bun run pr:ready ruleset
```

If `ok: false`, apply the canonical ruleset and re-verify:

```
bun run pr:ready ruleset --apply
```

If it still fails (typically a permissions error — ruleset writes need repo admin), report the `drift`
and continue with the rest of the flow; do not stop.

## 3. Commit and publish

```
bun run pr:ready context
```

From the actual `commits`/`files`/`diffstat` (never invent scope), write one Conventional Commit
message: a type from `feat`/`fix`/`chore`/`docs`/`test`/`refactor`/`ci`/`build`/`perf`/`style`, header at
most 120 characters, no invented scope. Write it to a temp file and commit:

```
bun run pr:ready commit --message-file /tmp/commit-msg.txt
```

If the result has `step: "commitlint"`, fix the message and retry (at most 3 attempts, then report).
If nothing is staged, `commit` reports `committed: false, reason: "nothing-to-commit"` — that is fine
when the work is already committed.

If the tip commit is already pushed and only its message is wrong, amend it instead of adding a new
commit — `bun run pr:ready commit --amend --message-file …` then
`bun run pr:ready publish --force-with-lease` — and say so in the PR body.

Publish the branch:

```
bun run pr:ready publish
```

## 4. Sync with the base branch

```
bun run pr:ready sync
```

- `alreadyUpToDate: true` or `merged: true` (exit 0) → continue. If `merged: true`, `publish` again.
- exit 3 (`step: "merge"`) → for each path in `conflicts`: read both sides (`git diff <path>`), resolve by
  hand preserving **both** intents (never take one side wholesale), `git add <path>`, then
  `bun run pr:ready sync --continue`. If the merge commit lands, `publish` again.
- exit 2 (`worktree not clean`) → commit first (step 3), then re-run `sync`.

Repeat until `sync` reports `alreadyUpToDate` or `merged` with no conflicts.

## 5. Open the PR

```
bun run pr:ready pr
```

If `created: false`, the PR already exists — do nothing. Otherwise, generate a Conventional-Commits
title (CI's `action-semantic-pull-request` enforces it) and a Markdown body with a `## Summary`
(2–4 bullets drawn from the `context` commits/files) and a `## Test plan` (the exact commands you ran).
Write the body to a temp file outside the repo, then:

```
bun run pr:ready pr --title "<conventional title>" --body-file /tmp/pr-body.md
```

If the PR is a draft and the work is ready, finish with:

```
bun run pr:ready pr --ready
```

## 6. Loop CI to green

```
bun run pr:ready checks
```

- exit 4 (`pending`/`timedOut`) → not done; run `checks` again.
- exit 1 (`failing`) → for each failing check:

  ```
  bun run pr:ready logs --name "<check name>"
  ```

  Read the failing lines, find the root cause, and fix it in-repo. Never weaken, skip, or disable a
  check; never edit workflow files to make a check pass; never delete tests. Reproduce locally with the
  closest replica (`bun run check:format`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run check`, or `bun scripts/ci-local.ts` for the full CI replica), then repeat step 3's
  `commit` + `publish` and re-run `checks`.

- Repeat until `checks` exits 0. If the same check fails twice after a fix attempt, stop guessing:
  read the full log and reproduce locally before the next push. If a failure is clearly not fixable
  in-repo, stop and report the check name, link, and log excerpt.

## 7. Completion

```
bun run pr:ready status
```

Report exactly: branch, upstream, PR number and URL, base branch, `mergeStateStatus`, every check name
with its bucket, and the required contexts. Success requires `checks` exit 0 with zero failures — never
report success on a partial, queued, or filtered run.

## Rules

- Never `git push --force`; only `--force-with-lease`, and only to fix an unpushed-tip message via `--amend`.
- Never push the base branch.
- Never `git reset --hard` or `git checkout .` to discard work.
- Never disable or bypass a check.
- Keep each fix minimal and focused on the failing check's root cause.
- Use the script's JSON instead of raw `git`/`gh` output.
- Do not paste full diffs or full CI logs into chat — quote only the failing lines.
