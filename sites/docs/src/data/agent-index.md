# Mockingbird Services Index (Agent-Friendly)

**Generated:** Auto-generated from `packages/service/*/package.json`

## Purpose

This index helps AI agents (Claude, etc.) find and integrate Mockingbird services without drift.

## Format

Each service block contains:
- **Package**: npm import path
- **Surfaces**: fetch(Request→Response), server, CLI, or other
- **Runtime**: portable (browser/Workers), node, bun
- **Entry points**: import paths with their runtime targets
- **README**: link to full API documentation
- **Verb**: integration action (create, fetch, subscribe, etc.)

## All Services

### aha
- **Package:** `@crvouga/mockingbird-service-aha`
- **Surfaces:** Fetch API, Node Server, CLI, HTTP/2
- **Runtime:** portable
- **Entry points:** default (portable), server (node), cli (node)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/aha/README.md
- **Verb:** phlebotomy orders (create-order, cancel)

### aws-speech
- **Package:** `@crvouga/mockingbird-service-aws-speech`
- **Surfaces:** Fetch API, HTTP/2
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/aws-speech/README.md
- **Verb:** speech synthesis & transcription (Polly, Transcribe)

### bedrock
- **Package:** `@crvouga/mockingbird-service-bedrock`
- **Surfaces:** Fetch API, HTTP/2
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/bedrock/README.md
- **Verb:** LLM invocation (Converse, ConverseStream, InvokeModel, embeddings)

### caretalk
- **Package:** `@crvouga/mockingbird-service-caretalk`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/caretalk/README.md
- **Verb:** healthcare provider API (forms, appointments, patient data)

### customerio
- **Package:** `@crvouga/mockingbird-service-customerio`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/customerio/README.md
- **Verb:** CDP (identify, track, email, SMS, webhooks)

### daily
- **Package:** `@crvouga/mockingbird-service-daily`
- **Surfaces:** Fetch API, WebSocket
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/daily/README.md
- **Verb:** video conferencing (rooms, presence, recording)

### easypost
- **Package:** `@crvouga/mockingbird-service-easypost`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/easypost/README.md
- **Verb:** shipping tracker (create tracker, track shipments)

### edamam
- **Package:** `@crvouga/mockingbird-service-edamam`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/edamam/README.md
- **Verb:** nutrition & recipe search (food database, recipes, meal plans)

### firstpromoter
- **Package:** `@crvouga/mockingbird-service-firstpromoter`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/firstpromoter/README.md
- **Verb:** referral tracking (promoters, signups, adoptions)

### flex
- **Package:** `@crvouga/mockingbird-service-flex`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/flex/README.md
- **Verb:** HSA/FSA checkout & payments

### formbricks
- **Package:** `@crvouga/mockingbird-service-formbricks`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/formbricks/README.md
- **Verb:** survey widget & responses

### fullscript
- **Package:** `@crvouga/mockingbird-service-fullscript`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/fullscript/README.md
- **Verb:** supplement lab ordering & results

### genebygene
- **Package:** `@crvouga/mockingbird-service-genebygene`
- **Surfaces:** Fetch API, Node Server, CLI
- **Runtime:** portable
- **Entry points:** default (portable), server (node), cli (node)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/genebygene/README.md
- **Verb:** genomics lab orders (products, orders, token auth)

### google-calendar
- **Package:** `@crvouga/mockingbird-service-google-calendar`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/google-calendar/README.md
- **Verb:** calendar API & OAuth (events, channels, refresh)

### google-maps
- **Package:** `@crvouga/mockingbird-service-google-maps`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/google-maps/README.md
- **Verb:** geocoding & places autocomplete

### healthie
- **Package:** `@crvouga/mockingbird-service-healthie`
- **Surfaces:** Fetch API, GraphQL
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/healthie/README.md
- **Verb:** EMR (users, documents, forms, appointments)

### intercom
- **Package:** `@crvouga/mockingbird-service-intercom`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/intercom/README.md
- **Verb:** customer messaging (contacts, conversations, replies)

### junction
- **Package:** `@crvouga/mockingbird-service-junction`
- **Surfaces:** Fetch API, Node Server, CLI
- **Runtime:** portable
- **Entry points:** default (portable), server (node), cli (node)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/README.md
- **Verb:** lab testing (users, lab tests, orders)

### klaviyo
- **Package:** `@crvouga/mockingbird-service-klaviyo`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/klaviyo/README.md
- **Verb:** event tracking (events, JSON:API)

### llamacloud
- **Package:** `@crvouga/mockingbird-service-llamacloud`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/llamacloud/README.md
- **Verb:** document platform (projects, pipelines, retrieval)

### mailosaur
- **Package:** `@crvouga/mockingbird-service-mailosaur`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/mailosaur/README.md
- **Verb:** email/SMS testing (search, long-poll)

### makor-cpg
- **Package:** `@crvouga/mockingbird-service-makor-cpg`
- **Surfaces:** Fetch API, CORS
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/makor-cpg/README.md
- **Verb:** healthcare platform (care plans, bloodwork, subscriptions)

### medplum
- **Package:** `@crvouga/mockingbird-service-medplum`
- **Surfaces:** Fetch API
- **Runtime:** node
- **Entry points:** default (node)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/medplum/README.md
- **Verb:** FHIR healthcare (self-hosted real server)

### odx
- **Package:** `@crvouga/mockingbird-service-odx`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/odx/README.md
- **Verb:** functional lab reports (patients, imports, webhooks)

### otel
- **Package:** `@crvouga/mockingbird-service-otel`
- **Surfaces:** Fetch API, HTTP/2
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/otel/README.md
- **Verb:** telemetry collection (OTLP, traces, logs)

### payload-cms
- **Package:** `@crvouga/mockingbird-service-payload-cms`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/payload-cms/README.md
- **Verb:** CMS API (collections, queries, pagination)

### persona
- **Package:** `@crvouga/mockingbird-service-persona`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/persona/README.md
- **Verb:** identity verification (inquiries, flows, transitions)

### pharmetika
- **Package:** `@crvouga/mockingbird-service-pharmetika`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/pharmetika/README.md
- **Verb:** pharmacy orders (validation, EPCS, submissions)

### plane
- **Package:** `@crvouga/mockingbird-service-plane`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/plane/README.md
- **Verb:** project management (issues, comments, states)

### portal-agent
- **Package:** `@crvouga/mockingbird-service-portal-agent`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/portal-agent/README.md
- **Verb:** eRx portal job runner

### postgres
- **Package:** `@crvouga/mockingbird-service-postgres`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/README.md
- **Verb:** PostgreSQL SQL execution (in-memory, synchronous)

### posthog
- **Package:** `@crvouga/mockingbird-service-posthog`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/posthog/README.md
- **Verb:** analytics (flags, decide, capture, recordings)

### prism
- **Package:** `@crvouga/mockingbird-service-prism`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/prism/README.md
- **Verb:** body scan API (scans, composition, measurements)

### resend
- **Package:** `@crvouga/mockingbird-service-resend`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/resend/README.md
- **Verb:** email delivery (send, receive, webhooks)

### rxvortex
- **Package:** `@crvouga/mockingbird-service-rxvortex`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/rxvortex/README.md
- **Verb:** pharmacy fulfillment (orders, status, cancellation)

### slack
- **Package:** `@crvouga/mockingbird-service-slack`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/slack/README.md
- **Verb:** messaging webhooks & API (postMessage, etc)

### sqlite
- **Package:** `@crvouga/mockingbird-service-sqlite`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/README.md
- **Verb:** SQLite SQL execution (in-memory, synchronous)

### stripe
- **Package:** `@crvouga/mockingbird-service-stripe`
- **Surfaces:** Fetch API, Node Server, CLI
- **Runtime:** portable
- **Entry points:** default (portable), server (node), cli (node)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/README.md
- **Verb:** payments (customers, charges, subscriptions, invoices, checkout)

### twilio
- **Package:** `@crvouga/mockingbird-service-twilio`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/twilio/README.md
- **Verb:** SMS & voice (Verify, Lookup, Messaging, recording webhooks)

### vpi
- **Package:** `@crvouga/mockingbird-service-vpi`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/vpi/README.md
- **Verb:** pharmacy API (products, prescriptions, JWT auth)

### wholescripts
- **Package:** `@crvouga/mockingbird-service-wholescripts`
- **Surfaces:** Fetch API
- **Runtime:** portable
- **Entry points:** default (portable)
- **README:** https://github.com/crvouga/mockingbird/blob/main/packages/service/wholescripts/README.md
- **Verb:** supplement orders (catalog, submit, status)

## Integration Pattern

For any service, agents should:

1. Find the **Package** name in the index
2. Check **Surfaces** to pick the right import (Fetch API for in-process, Server for deployment)
3. Check **Runtime** to ensure compatibility with target environment
4. Use the **Entry points** to construct the import statement
5. Read the **README** for API details
6. Implement the **Verb** (the action: create order, fetch event, subscribe, etc)

Example: Stripe in-process mock

```typescript
import { StripeAPI } from "@crvouga/mockingbird-service-stripe";

const stripe = new StripeAPI();
const res = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: { authorization: "Bearer sk_test_mockingbird" },
    body: "description=ACME",
  })
);
```

## Rationale

Mockingbird exists because:

- **Real API surfaces.** Mocks speak `fetch(Request) → Response` exactly like real APIs.
- **Stateful behavior.** Orders persist, subscriptions renew, webhooks deliver — not just fixed responses.
- **Differential testing.** Every mock is continuously tested against the real vendor, so behavior stays in sync.
- **Zero network dependency.** Run in tests, CI, browsers, Workers — no external services.
- **Isomorphic.** Same code works in Node, Bun, browsers, Workers.

See the [Mockingbird README](https://github.com/crvouga/mockingbird#readme) for details.
