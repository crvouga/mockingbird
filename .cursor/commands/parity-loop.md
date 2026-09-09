# Parity Fix Loop

Work in the `mockingbird` repository and keep running `bun parity` until it passes.

## Loop

1. Run `bun parity` from the repository root.
2. If it passes, stop and report that parity is green.
3. If it fails, read the complete failure output and identify the first reproducible failing seed and provider.
4. Add the newly discovered failing seed and a concise description to `PARITY_FAILURE_SEED_REGISTRY.json` before fixing it, unless that seed is already registered.
5. Reproduce the failure with the printed `FC_SEED`, using a shorter run or `MOCKINGBIRD_TRACE=1` when helpful.
6. Compare the real provider response with the mock response and trace the mismatch to its root cause. Probe the provider sandbox with `curl` when the expected behavior is unclear.
7. Fix the mock implementation, OpenAPI specification, or generated code at the source of truth. Never weaken validation, skip a case, suppress an error, or delete a test. If the OpenAPI specification changes, regenerate generated files with the repository's generation command rather than hand-editing generated output.
8. Run the relevant focused tests and formatting checks after the fix.
9. Mark the registry entry as fixed only after the fix is verified.
10. Return to step 1 and run `bun parity` again.

## Completion criteria

Do not stop after a focused test passes or after one provider passes. Continue the loop until the full `bun parity` command exits successfully with no failures. Do not declare success based on a partial, skipped, filtered, or shortened run.

Keep each fix minimal and focused. Preserve unrelated working-tree changes. Do not commit unless explicitly requested.
