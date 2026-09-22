---
name: Bug
about: A mock crashes, leaks state between namespaces, contradicts its README, or fails to install, build or type-check.
title: "[<service>] bug: <what breaks>"
labels: agent-reported, bug
---

<!-- Guide: docs/REPORTING_ISSUES.md. Redact every key, token and secret; use fake personal data. -->

## Service

- Package: `@crvouga/mockingbird-service-<service>@<exact installed version>`
- Runtime: Node <version> / Bun <version>, OS <os>
- Mode: <in-process createRuntime | createServer | mockingbird-<service> serve>

## What breaks

<!-- One or two sentences: what you did, what you expected (cite the README if it says so), what happened. -->

## Reproduction

```ts
// Self-contained script or commands that reproduce it from a clean install.
```

## Output

```
error message, stack trace, or the wrong response
```
