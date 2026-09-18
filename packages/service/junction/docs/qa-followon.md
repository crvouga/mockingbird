# QA follow-on: point a QA suite at Mockingbird Junction

**Blocked until** [`qa-drop-in.md`](./qa-drop-in.md) is fully `monkey-green`.

These are the steps a consumer performs in its own repository. Nothing here is a dependency of this
project: the mock is complete on its own side; this is the checklist for wiring a client to it.

When the monkey suite proves drop-in:

1. Serve the mock via `@crvouga/mockingbird-adapter-node` (or `Bun.serve`) on localhost.
2. Allow `127.0.0.1` / `localhost` in the consumer's Vital host allowlist, keeping its
   production and sandbox guards intact.
3. Point the consumer's Vital API URL at the mock and use a mock sandbox key (the `sk_us_*` shape).
4. Re-enable the junction suite in the consumer's test matrix only after the matrix is green.
5. Keep sparse live-sandbox goldens opt-in where geo corpora still need real PSC inventories.

Do not flip a default QA run onto a partial allowlist.
