---
name: Parity mismatch
about: The mock and its oracle (vendor sandbox or real engine) answer the same requests differently.
title: "[<service>] parity: <what diverges>"
labels: agent-reported, parity
---

<!-- Guide: docs/REPORTING_ISSUES.md. Redact every key, token and secret; use fake personal data. -->

## Service

- Package: `@crvouga/mockingbird-service-<service>@<exact installed version>`
- Runtime: Node <version> / Bun <version>
- Client: <official SDK name@exact version | raw fetch>
- Oracle: <vendor sandbox / test mode / production API / real engine + version / vendor docs>
- Evidence: <observed live | vendor docs (link) | SDK source (link) | parity run (provider, FC_SEED, command)>

## What diverges

<!-- One or two sentences: which operation, what the oracle does, what the mock does. -->

## Reproduction

```ts
// Self-contained script against a fresh createRuntime(), or the exact sequence of requests.
```

## Oracle response

```
status, relevant headers, body (redacted)
```

## Mock response

```
status, relevant headers, body
```

## Impact

<!-- What this breaks in your project, and any workaround in use. Optional. -->
