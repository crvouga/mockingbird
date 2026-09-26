# Reporting issues

How coding agents in other projects file a GitHub issue when a mock diverges from its oracle, lacks a feature they call, or breaks, or when they need a service mocked that the catalog does not have yet. Agents in this repository pick the issues up and resolve them.

This guide is written for coding agents. Read it top to bottom once, then use
[Quick reference](#quick-reference) as the checklist every time you file.

A mock's **oracle** is the thing it must behave like: the vendor's sandbox or test API for an
HTTP mock (Stripe test mode, the Junction sandbox, …), the real engine for the database mocks
(SQLite, PostgreSQL), and a real Medplum server for `medplum`. When your tests show that the mock
and its oracle disagree, or the mock lacks something you need, file an issue. Do not quietly work
around the mock in your own project. The issue is how the mock gets fixed for everyone.

## Quick reference

| You found | Kind | Title | Template |
| --- | --- | --- | --- |
| The mock and the oracle answer the same request differently | `parity` | `[<service>] parity: <what diverges>` | [parity.md][t-parity] |
| The mock lacks an operation, parameter, event, or behavior your code uses | `feature` | `[<service>] feature: <what is missing>` | [feature.md][t-feature] |
| The mock crashes, leaks state, contradicts its README, or does not install or build | `bug` | `[<service>] bug: <what breaks>` | [bug.md][t-bug] |
| No package mocks the vendor you depend on | `new-service` | `[new-service] <Vendor>: <API surface>` | [new-service.md][t-new] |

`<service>` is the package suffix: `stripe` for `@crvouga/mockingbird-service-stripe`. The
catalog is listed in [`llms.txt`](../llms.txt).

1. [Search for an existing issue](#1-search-first). Comment on it rather than opening a duplicate.
2. [Redact](#never-include) keys, tokens and personal data.
3. Copy the kind's template, fill in every section, and save it to a file.
4. File it:

   ```bash
   gh issue create --repo crvouga/mockingbird \
     --title "[stripe] parity: POST /v1/customers accepts an invalid email" \
     --label agent-reported,parity \
     --body-file issue.md
   ```

5. Give your human the issue URL.

File one issue per divergence, missing feature, or service, so each one can be fixed, tested and
closed independently. The title prefix alone is enough: a workflow applies the `agent-reported`
and kind labels from it, including when your account cannot set labels.

## When to file, and when not to

File when:

- **parity**: the status, body shape, field value, error code, ordering, pagination, webhook
  payload or signature, or side effect differs from the oracle's for the same requests.
- **feature**: your code calls something the mock answers with 404, `not implemented`, or by
  silently ignoring it. Check the package's `SUPPORT.md` / `COMPATIBILITY.md` first. A feature
  can be a whole operation, one parameter or filter, a webhook event, a lifecycle transition, an
  error case, or an admin control (a fault preset, an outbox, a clock advance) your tests need.
- **bug**: the mock crashes, leaks state between namespaces, contradicts its own README, or fails
  to install, build, or type-check.
- **new-service**: you depend on a vendor API that no package mocks, and you would use a mock in
  your tests if one existed.

Do not file when:

- The package README (under **Deliberately not modelled**) or `SUPPORT.md` documents the
  divergence as intentional. If you think the decision is wrong, file a `feature` issue that
  explains what the omission breaks for you.
- You only suspect how the vendor behaves. State what the oracle actually returned and how you
  know (a live response, the vendor docs, the SDK source). "Stripe probably returns 400" is a
  guess, not a report.
- The cause is your own code or configuration: a wrong base URL, a missing
  `x-mockingbird-namespace`, or state left over from an earlier test.

## Never include

These packages mock health, payments, and identity APIs, and issues are public. Before you file,
remove:

- API keys, tokens, webhook secrets, passwords, and signed URLs. Replace each one with `<redacted>`.
- Real personal data or PHI: names, emails, phone numbers, addresses, dates of birth, lab results.
  Use obviously fake values (`jane@example.com`, `+15005550006`).
- Your project's proprietary source. Describe the behavior at the wire, as requests and responses,
  instead of pasting your code.

When you cannot show the problem without sensitive data, stop and ask your human instead of filing.

## 1. Search first

```bash
gh issue list --repo crvouga/mockingbird --state all --search "<service or vendor> <operation or field> in:title,body"
```

If an open issue covers the same thing, add a comment with your evidence (package version,
requests, responses, or the behaviors you need) instead of opening a duplicate. A 👍 reaction on a
`new-service` or `feature` issue also counts as demand. If a closed issue covers it, check that you
are on a version at or after the fix before you reopen it.

## 2. Parity and bug reports: reduce to a reproduction

Reduce the failure to the smallest sequence of requests against a fresh mock that shows it. Prefer
a self-contained script that runs the mock in-process:

```ts
import { createRuntime } from "@crvouga/mockingbird-service-<service>"

const mock = createRuntime()
const res = await mock.fetch(
  new Request("http://mock/v1/customers", {
    method: "POST",
    headers: { authorization: "Bearer sk_test_<redacted>", "content-type": "application/x-www-form-urlencoded" },
    body: "email=not-an-email",
  }),
)
console.log(res.status, await res.text())
```

Record the oracle's response to the same requests. If you captured it live, paste the status and
the redacted body. If it comes from vendor documentation, link the page. If it comes from a parity
run, include the provider, the `FC_SEED`, and the command that reproduces it.

## 3. Features and new services: describe the behavior

A `feature` or `new-service` issue is a specification. The agent that picks it up turns each
behavior into an acceptance test and then builds the mock until the tests pass, so write what the
mock must do, observed from outside, rather than how to build it. Everything below is what that
agent needs and cannot guess.

**How you will use it.** Say whether your code calls the API through the vendor's official SDK
(name and exact version) or through raw `fetch`, how you point it at a different base URL (an SDK
option or environment variable), and whether you will run the mock in-process (`createRuntime().fetch`)
or as a server (`npx mockingbird-<service> serve`). The SDK version decides the wire format the
mock must speak.

**Surface.** List only the operations you call. For each one, give the method and path, what
your code sends (the parameters and body fields you actually set), and which response fields
your code reads. Link the vendor's reference page and its OpenAPI or Postman file, if one is
published.

**Auth.** The scheme (bearer, basic, HMAC request signing, AWS SigV4, OAuth client credentials),
the header names, and what the vendor answers when credentials are missing or wrong.

**State.** The resources and how they relate: which ids the API returns, which ids a request
references, the lifecycle states a resource moves through, and what moves it (a request, the
passage of time, an action in the vendor's dashboard, a webhook).

**Behaviors.** Numbered Given / When / Then statements. Each one must be checkable through the
API alone, and together they must cover the failures your code handles as well as the happy path:

```text
B1. Given no orders exist, when I POST /v1/orders with a valid body, then the response is 201
    with an `id` starting `ord_` and `status: "pending"`, and GET /v1/orders/{id} returns the
    same order.
B2. Given an order in `pending`, when I POST /v1/orders/{id}/cancel, then its status is
    `cancelled` and an `order.cancelled` webhook is delivered.
B3. When I POST /v1/orders without `patient_id`, then the response is 422 with
    `{ "errors": { "patient_id": ["is required"] } }`.
B4. Given 101 orders, when I GET /v1/orders?limit=100, then 100 are returned with a `next_cursor`,
    and following the cursor returns the last one.
```

**Webhooks.** For each event your code receives: when it fires, a redacted payload, the signature
scheme (header name, algorithm, what is signed, timestamp tolerance), and the retry behavior you
depend on.

**Test controls.** What your tests need to force that a real sandbox cannot easily do, such as
advancing an order to `shipped`, making the next call return 429 or time out, reading the messages
a comms API "sent", or returning a lab result. Each control becomes an `/__admin` route or a fault
preset.

**Out of scope.** Operations and behaviors you do not need, so the mock stays small.

**Oracle.** Whether the vendor offers a sandbox or test mode, whether it is free, and how a
maintainer gets access. Never include the credentials themselves.

A `feature` request on an existing mock uses the same sections, trimmed to the one feature. A
`new-service` request with a clear surface and concrete behaviors is ready to build. One that
only names the vendor waits until someone supplies them.

## 4. File the issue

Copy the template for the kind (links below), fill in every section, delete the HTML comments,
and save it to a file. Then run:

```bash
gh issue create --repo crvouga/mockingbird \
  --title "<title in the format from the quick reference>" \
  --label agent-reported,<kind> \
  --body-file issue.md
```

| Kind | Template (raw, for copying) |
| --- | --- |
| `parity` | <https://raw.githubusercontent.com/crvouga/mockingbird/main/.github/ISSUE_TEMPLATE/parity.md> |
| `feature` | <https://raw.githubusercontent.com/crvouga/mockingbird/main/.github/ISSUE_TEMPLATE/feature.md> |
| `bug` | <https://raw.githubusercontent.com/crvouga/mockingbird/main/.github/ISSUE_TEMPLATE/bug.md> |
| `new-service` | <https://raw.githubusercontent.com/crvouga/mockingbird/main/.github/ISSUE_TEMPLATE/new-service.md> |

Each template begins with a `---` front-matter block; leave it out of the body file.

If `gh` is not installed or not authenticated, do not install it or log in on your own. Give your
human the finished title and body and the link to the matching form, for example
<https://github.com/crvouga/mockingbird/issues/new?template=new-service.md>.

## What happens next

Agents in this repository run `/resolve-issues` on the `agent-reported` queue.

- **parity** and **bug**: the agent checks the claim against the oracle, adds a failing regression
  test, fixes the mock where the behavior is defined (implementation, OpenAPI contract, or
  generator), and opens a PR that closes the issue. If the oracle does not behave as reported,
  the agent comments with what it observed and closes the issue.
- **feature**: the agent confirms the behavior against the oracle or vendor documentation, adds
  it to the contract, and ships it with an acceptance test for each behavior you listed.
- **new-service**: the agent builds a new package by following
  [AUTHORING_A_SERVICE.md](AUTHORING_A_SERVICE.md). Your behaviors become its acceptance suite and
  your SDK version its drop-in test. It is released as `wip` until it is verified.

An issue labelled `needs-info` is waiting on you: answer the question in the comments. Fixes ship
in the next release of the package; see [RELEASING.md](RELEASING.md).

[t-parity]: https://github.com/crvouga/mockingbird/blob/main/.github/ISSUE_TEMPLATE/parity.md
[t-feature]: https://github.com/crvouga/mockingbird/blob/main/.github/ISSUE_TEMPLATE/feature.md
[t-bug]: https://github.com/crvouga/mockingbird/blob/main/.github/ISSUE_TEMPLATE/bug.md
[t-new]: https://github.com/crvouga/mockingbird/blob/main/.github/ISSUE_TEMPLATE/new-service.md
