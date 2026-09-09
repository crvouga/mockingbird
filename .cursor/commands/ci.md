# Check Loop

You are making the mockingbird repo fully green: **all checks** (lint, typecheck, build, tests,
portability, pack, boundaries) **and live parity** (differential property tests against each
provider's real sandbox). Run the checks, fix every failure at its root cause, repeat until
everything passes, then commit. Never stop on a green-ish subset and never disable, skip,
comment out, or loosen a check to make it pass.

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
3. **Run live parity.** `bun run check` does **not** cover parity (it needs sandbox
   credentials + network). Run it per provider, serialized:
   ```bash
   bun run parity                  # junction (root script)
   bun run parity:junction         # junction
   bun run parity:stripe           # stripe
   bun run parity:genebygene       # genebygene
   bun run parity --filter=@crvouga/mockingbird-service-junction --concurrency=1
   ```
   Replay a specific failing walk with the seed printed in the error:
   ```bash
   FC_SEED=2032472120 bun run parity:junction
   FC_SEED=2032472120 bun run parity:junction -- --runs 10 --steps 12   # shorter run, faster
   MOCKINGBIRD_TRACE=1 bun run parity:junction                              # trace each step
   ```
   The self-parity property suite (two independent mocks) needs **no** credentials and is great
   for fast local iteration:
   ```bash
   # inside packages/service/<provider>
   bun test                                  # run the *.property.test.ts suites
   FC_SEED=2032472120 bun test               # replay a seed
   ```
4. **Diagnose.** When a command fails, read the full failure output. Identify the actual root
   cause. Do not fix only the reported symptom — trace it to the source (e.g., a type error may
   show up as a build failure; a boundary violation may appear only in checks).
5. **Fix the root cause.**
   - Run `bun run format` again after editing source files so formatting stays consistent.
   - Do not "fix" a failing check by weakening it: no rule disables/suppresses
     (`// biome-ignore`, `// eslint-disable`, `@ts-ignore`, `ts-expect-error` used to mask, etc.),
     no config changes to silence a check, no skipping/excluding of files, no `XFAIL`/`todo`
     workarounds, no deleting tests.
   - Generated code (`src/generated/**`, `openapi.yaml`) is produced by codegen from
     `openapi.yaml` + `codegen.json`. If it is stale, regenerate it and commit the regeneration —
     do not hand-patch generated files.
6. **Re-run.** Re-run `bun run check` (and the relevant `parity:*`). If anything still fails,
   go back to step 4. Keep looping until the full suite is green.
7. **Commit.** Only commit when green. Stage the intended files, write a concise Conventional
   Commit message matching repo style, and commit. Commit after each green milestone so progress
   is preserved.

## Live parity details

Live parity replays the same random API walk against a provider's real sandbox and against the
mock, canonicalizes both responses (strips volatile ids, timestamps, tokens), and
structural-diffs them. Any divergence is a failure.

### Credentials

Credentials come from env or the self-hosted Vault (see `docs/SECRETS.md`). `VAULT_ADDR` is
usually already set; the token lives in `~/.vault-token`.

```bash
bun run secrets:doctor
```

Fetch a key from Vault — **never truncate it** (the value is long; `head -c` clips it and you'll
get `401 invalid token`):

```bash
API_KEY=$(vault kv get -mount=secret -field=MOCKINGBIRD_JUNCTION_API_KEY secret)
# others: MOCKINGBIRD_STRIPE_SECRET_KEY, MOCKINGBIRD_GENEBYGENE_CLIENT_ID, _CLIENT_SECRET
```

Provider sandboxes (from `packages/service/*/scripts/parity.ts`):
- Junction: `https://api.sandbox.us.junction.com`, header `x-vital-api-key`, key `sk_us_*` / `sk_eu_*`
- Stripe: `https://api.stripe.com`, header `authorization: Bearer`, key `sk_test_*`
- GeneByGene: staging OAuth client id/secret

### Read the failure precisely

A parity failure prints the **real vs mock** response, the canonical forms, and the diff:

```
differences:
  $.body.kind: real="json" mock="empty"
  $.body.value: only in real: {"detail":"Nothing to patch"}
  $.status: real=400 mock=204
```

- The **minimal** reproduction is on the `Counterexample:` line. The long `Encountered failures
  were:` block is fast-check's shrink trail — you can ignore it.
- `kind: mismatch` = real and mock diverged. `kind: mock-conformance` = the mock returned a
  status or body not declared in the vendored OpenAPI spec (e.g. `status 400 is not declared
  for <operation>`).
- Status, body `kind`, and body `value` are all compared. Volatile ids/timestamps/tokens are
  canonicalized away, so focus on **status + non-volatile body** differences.
- Error bodies (`detail`) are compared **strictly** unless the schema annotates them. If the real
  returns a FastAPI-style `{"detail":[{...}]}` array, the mock must return the same.

### Probe the real API to learn ground truth

The vendored `openapi.yaml` is a hand-authored subset and is **often incomplete** relative to the
real provider. When a mismatch shows a status/body the spec doesn't declare, or you're unsure what
the real API does, probe it directly with `curl` using the sandbox key.

```bash
API_KEY=$(vault kv get -mount=secret -field=MOCKINGBIRD_JUNCTION_API_KEY secret)
BASE=https://api.sandbox.us.junction.com
# create a resource, then exercise the failing operation with edge-case bodies
uid=$(curl -s -X POST "$BASE/v2/user" -H "x-vital-api-key: $API_KEY" \
  -H 'content-type: application/json' -d '{"client_user_id":"probe-'$RANDOM'"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["user_id"])')
curl -s -w '\nHTTP:%{http_code}' -X PATCH "$BASE/v2/user/$uid" \
  -H "x-vital-api-key: $API_KEY" -H 'content-type: application/json' -d '{}'
```

Probe the boundary cases the command generator can produce (empty body, `null` values, unknown
fields, conflict/duplicate ids, wrong types, delete-then-access). Record the exact status **and**
body.

### Fix the mock

Mock handlers live in `packages/service/<provider>/src/*.ts` (e.g. `users.ts`). Make the handler
return exactly what the real API returns — same status, same body shape, same `detail` text/array.

Common fixes this repo needs:
- **Empty / no-op body** → real returns a `400` with a specific message (e.g. `Nothing to patch`).
- **Nullable field set to `null`** → field-specific: some fields accept `null` (clear → `204`),
  some reject it with a `422` `value_error` (e.g. Junction's `client_user_id`).
- **Conflict / duplicate** → real returns `409` with a specific message (e.g.
  `Client user id already exists`), not a generic `422`.
- **Validation error shape** → FastAPI returns `{"detail":[{type,loc,msg,input,...}]}` arrays.
  The mock's `HttpError(422, { detail: "..." })` string does **not** match; build the array.
- **Delete-then-access** → real keeps the id "scheduled for deletion" and returns a per-endpoint
  message (e.g. GET `You have scheduled this user for deletion.`, PATCH/DELETE
  `The user has been scheduled for deletion as per your previous request`). Track deleted ids.

### Update the spec and regenerate

If you change the mock to return a status the spec doesn't declare, `validateMock` fails
(`status X is not declared for <operation>`). Add that response to `openapi.yaml`:

```yaml
responses:
  "400":
    description: Nothing to patch
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/HTTPValidationError"
```

Then **regenerate** the generated code — never hand-patch `src/generated/openapi.ts`:

```bash
# inside packages/service/<provider>
bun run generate      # regenerates src/generated/openapi.ts + SUPPORT.md
bun run build
```

## Rules

- `bun run check` is the source of truth. A change is not "done" until that command is green end
  to end, and live parity (`parity:*`) is green for the provider you touched.
- Fix the root cause. If the same failure reappears, you did not fix the root cause.
- Never disable a check, never hide a failure, never reduce coverage to make tests pass.
- If a failure appears unrelated to your changes, assume it is still your responsibility to make
  it green — but first verify with git that it isn't a pre-existing break, and if it is, still fix it.
- Do not prune, refactor, or "improve" unrelated code while fixing checks; keep the diff minimal
  and focused.
- When unsure what the real API does, **probe it** with `curl` rather than guessing.
- Commit only when green, with a concise Conventional Commit message.
