---
name: Missing feature
about: An existing mock lacks an operation, parameter, event, behavior or test control your code uses.
title: "[<service>] feature: <what is missing>"
labels: agent-reported, feature
---

<!-- Guide: docs/REPORTING_ISSUES.md#3-features-and-new-services-describe-the-behavior.
     Describe behavior at the wire, not your project's source. Redact secrets; fake data only. -->

## Service

- Package: `@crvouga/mockingbird-service-<service>@<exact installed version>`
- Client: <official SDK name@exact version | raw fetch>
- Mock answers today: <404 | not implemented | parameter ignored | wrong behavior — paste status/body>
- Checked `SUPPORT.md` / README "Deliberately not modelled": <yes — not listed | listed, and here is why it matters>

## What is missing

<!-- One or two sentences. -->

## Surface

| Method | Path | What your code sends | Response fields your code reads |
| --- | --- | --- | --- |
| | | | |

Vendor reference: <link to the API reference page / OpenAPI>

## Behaviors

<!-- Numbered Given / When / Then, each checkable through the API. Include the errors you handle. -->

1. Given …, when …, then …

## Webhooks and test controls

<!-- Events this must emit (payload, signature), and any /__admin control or fault preset your
     tests need to force a state. Delete if none. -->

## Oracle

- Evidence: <observed live (redacted request + response below) | vendor docs (link) | SDK source (link)>

```
oracle request and response (redacted), if observed live
```
