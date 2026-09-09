# Geviti follow-on: point QA at Mockingbird Junction

**Blocked until** [`qa-drop-in.md`](./qa-drop-in.md) is fully `monkey-green`.

When the monkey suite proves drop-in:

1. Serve the mock via `@crvouga/mockingbird-adapter-node` (or Bun.serve) on localhost.
2. Extend Geviti [`QA_VITAL_ALLOWED_HOSTS`](../../../../geviti-monorepo/packages/app/src/safety-config/safety-config.ts) to allow `127.0.0.1` / `localhost` for Vital URL checks (keep prod/sandbox guards intact).
3. Point localhost-stack `VITAL_API_URL` at the mock; use a mock sandbox key (`sk_us_*` shape).
4. Re-enable `junction` in [`api-test-matrix-slugs.ts`](../../../../geviti-monorepo/packages/qa/src/shared/api-test-matrix-slugs.ts) only after matrix green.
5. Keep sparse live-sandbox goldens opt-in if geo corpora still need real PSC inventories.

Do not flip default QA onto a partial allowlist.
