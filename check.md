# Check Loop

You are verifying the repo is fully green. Run the checks, fix every failure at its root cause, and repeat until everything passes. Never stop on a green-ish subset and never disable, skip, comment out, or loosen a check to make it pass.

## Procedure

1. **Format first.** Run `bun run format` (Biome) so formatting churn doesn't pollute later results.
2. **Run the full check suite.** Run `bun run check`, which runs, via Turbo:
   - lint (`biome check .` per package)
   - typecheck
   - openapi:check
   - generate:check
   - build
   - test
   - portability
   - pack:check
   - check:boundaries, check:tests, check:format
3. **Diagnose.** When a command fails, read the full failure output. Identify the actual root cause. Do not fix only the reported symptom — trace it to the source (e.g., a type error may show up as a build failure; a boundary violation may appear only in checks).
4. **Fix the root cause.**
   - Run `bun run format` again after editing source files so formatting stays consistent.
   - Do not "fix" a failing check by weakening it: no rule disables/suppresses (`// biome-ignore`, `// eslint-disable`, `@ts-ignore`, `ts-expect-error` used to mask, etc.), no config changes to silence a check, no skipping/excluding of files, no `XFAIL`/`todo` workarounds, no deleting tests.
   - Generated code (`src/generated/**`, `openapi.yaml`) is produced by codegen from `openapi.yaml` + `codegen.json`. If it is stale, regenerate it and commit the regeneration — do not hand-patch generated files.
5. **Re-run.** Re-run `bun run check`. If anything still fails, go back to step 3. Keep looping until the full suite is green.
6. **Done.** Stop only when `bun run check` exits successfully and `bun run format` produces no diffs.

## Rules

- `bun run check` is the source of truth. A change is not "done" until that command is green end to end.
- Fix the root cause. If the same failure reappears, you did not fix the root cause.
- Never disable a check, never hide a failure, never reduce coverage to make tests pass.
- If a failure appears unrelated to your changes, assume it is still your responsibility to make it green — but first verify with git that it isn't a pre-existing break, and if it is, still fix it.
- Do not prune, refactor, or "improve" unrelated code while fixing checks; keep the diff minimal and focused.