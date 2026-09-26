---
name: New service
about: Request a mock for a vendor API the catalog does not cover, specified as the behaviors you need.
title: "[new-service] <Vendor>: <API surface>"
labels: agent-reported, new-service
---

<!-- Guide: docs/REPORTING_ISSUES.md#3-features-and-new-services-describe-the-behavior.
     This is a specification: each behavior becomes an acceptance test. List only what your code
     uses. Describe the wire, not your project's source. Redact secrets; fake data only. -->

## Vendor

- Vendor and API: <e.g. Acme Labs Orders API v2>
- Base URL(s): <https://api.acme.example/v2>
- Reference docs: <link>
- Published OpenAPI / Postman: <link | none>
- API version you pin: <header or path version | n/a>

## How you will use it

- Client: <official SDK name@exact version | raw fetch>
- Pointing it at the mock: <SDK option or env var, e.g. `ACME_BASE_URL`>
- Mode: <in-process createRuntime().fetch | served over HTTP>
- Why you need a mock: <e.g. the sandbox is paid, rate-limited, cannot force failures, sends real messages>

## Auth

<!-- Scheme, header names, and what the vendor answers when credentials are missing or wrong. -->

## Surface

| Method | Path | What your code sends | Response fields your code reads |
| --- | --- | --- | --- |
| | | | |

## State

<!-- Resources, their id formats, how they reference each other, lifecycle states and what moves
     a resource between them (a request, time, the vendor's dashboard, a webhook). -->

## Behaviors

<!-- Numbered Given / When / Then, each checkable through the API alone. Cover the errors,
     pagination, idempotency and edge cases your code handles, not just the happy path. -->

1. Given …, when …, then …
2. When … is missing, then the response is <status> with <body>.

## Webhooks

<!-- For each event: when it fires, a redacted payload, the signature scheme (header, algorithm,
     signed content, timestamp tolerance), and retries you depend on. Delete if none. -->

## Test controls

<!-- What your tests must force that the real sandbox cannot easily do: advance a lifecycle, make
     the next call 429 or time out, read what a comms API "sent", inject a result. -->

## Out of scope

<!-- Operations and behaviors you do not need. -->

## Oracle

- Sandbox or test mode: <yes, free | yes, paid | no>
- How a maintainer gets access: <self-serve signup | sales | n/a>
