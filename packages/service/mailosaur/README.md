# @crvouga/mockingbird-service-mailosaur

Stateful mock of the **Mailosaur** email/SMS testing API for test suites, plus an HTTP ingest so
anything that "sends" mail (the Resend mock's `--forward-to-inbox`, the Twilio mock, Cognito
hooks, a test) drops it into one inbox. The unmodified `mailosaur` SDK reads it: `messages.get`
returns within ~20 ms of a message arriving instead of long-polling Mailosaur for up to 120 s,
and `html.codes` / `text.codes` / `html.links` are parsed the way Mailosaur parses them.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/mailosaur/SUPPORT.md)
- The vendor publishes no OpenAPI spec: `openapi.yaml` is hand-authored from `mailosaur@11.1.0`
  (the requests it sends and the fields its models read) and our consumer's client.

## Install

```bash
npm install -D @crvouga/mockingbird-service-mailosaur
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-mailosaur serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

### Pointing the `mailosaur` SDK at it

The SDK only speaks HTTPS (`https.request`, whatever the base URL's scheme) and **drops the base
URL's port** (it passes only the hostname and path, so it always connects to 443). So a
`MAILOSAUR_BASE_URL` alone (G-M1) only works if the mock listens on 443. The mock's secure port
therefore also acts as an HTTP `CONNECT` proxy that tunnels **every** target into the mock (never
to the network). The SDK honours `HTTPS_PROXY`, reading it once, when a client is constructed:

```bash
npx mockingbird-mailosaur serve --port 8793 --tls-port 8794 --tls-cert-out /tmp/mailosaur-mock.pem
# in the process that constructs the SDK client:
HTTPS_PROXY=http://127.0.0.1:8794 NODE_EXTRA_CA_CERTS=/tmp/mailosaur-mock.pem
```

With that, `new MailosaurClient(apiKey)` keeps its default `https://mailosaur.com/` and every
call lands in the mock. The generated certificate names `localhost`, `127.0.0.1` and
`mailosaur.com`. Set `HTTPS_PROXY` only around the SDK construction if the rest of the process
must not see it, since other HTTP clients (axios) also read it and would be tunnelled into the
mock too. If the mock can bind 443, `--tls-port 443` and `new MailosaurClient(key,
"https://127.0.0.1/")` work without the proxy.

```ts
import { createServer } from "@crvouga/mockingbird-service-mailosaur/server"
import MailosaurClient from "mailosaur"

const inbox = await createServer({ tls: true })
// …trust inbox.cert (NODE_EXTRA_CA_CERTS, or tls.setDefaultCACertificates in a test)…
process.env.HTTPS_PROXY = inbox.proxyUrl
const mailosaur = new MailosaurClient("any-key")
delete process.env.HTTPS_PROXY

// Something "sends" the signup email:
await fetch(`${inbox.url}/__admin/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    to: "member-app-x1@abcd1234.mailosaur.net",
    subject: "Your verification code",
    text: "Your verification code is 604218. ",
  }),
})
const message = await mailosaur.messages.get("abcd1234", { sentTo: "member-app-x1@abcd1234.mailosaur.net" })
message.text?.codes?.[0]?.value // "604218"
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /api/messages/search?server=&page=&itemsPerPage=&receivedAfter=&dir=` | Body `{sentTo?, sentFrom?, subject?, body?, match?: "ALL"\|"ANY"}`. `sentTo` / `sentFrom` match an address exactly (any of to/cc/bcc, case-insensitive); `subject` / `body` are case-insensitive contains. `{items: [summary]}`, newest first (`dir=Ascending` flips). Answers at once, with `x-ms-delay: 20` (the SDK's poll interval while nothing matches), which is how `messages.get` returns ~20 ms after arrival. |
| `POST /api/messages/await?server=&receivedAfter=&timeout=` | Server-side long-poll: the full message the moment one matches, or 404 `{type: "search_timeout"}` after `timeout` ms (default 10000, at most 300000). `GET` takes the criteria as query parameters. |
| `GET /api/messages?server=` | `messages.list`: summaries, newest first. |
| `POST /api/messages?server=` | `messages.create`: stores `{to, subject, text?, html?, from?, cc?}` in the server. |
| `DELETE /api/messages?server=` | `messages.deleteAll`: 204. |
| `GET /api/messages/{id}` | `messages.getById`: the full message (`from[]`, `to[]`, `cc[]`, `bcc[]`, `received`, `subject`, `html{body, links[{href,text}], codes[{value}], images[]}`, `text{body, links, codes}`, `attachments[]`, `metadata`, `server`), or 404. |
| `DELETE /api/messages/{id}` | `messages.del`: 204, or 404. |

Auth is `Authorization: Basic base64(<api key>:)` (what the SDK sends); any key works, none is a
401 `authentication_error`. A 400 names the field the way the SDK's error parser expects
(`{errors: [{field, detail: [{description}]}]}`).

**Servers** are implicit. A message's server is, in order: the ingest's `server`, the id in a
`<server>.mailosaur.net` recipient, or `*` (visible from every server id). `receivedAfter` keeps
messages received at or after the instant (on the mock clock).

**Codes and links.** `codes[]` lists every distinct standalone run of 4–8 digits in the readable
text (HTML without head, styles, scripts, tags; entities decoded), ignoring digits inside URLs.
Our consumer keeps the first 6-digit one. `html.links` is every `<a href>` with its text;
`text.links` every URL in the text body.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/ingest` | `{to, from?, cc?, bcc?, subject?, html?, text?, server?, type?: "Email"\|"SMS", headers?, attachments?: [{filename, content (base64), contentType}]}` → 201 with the parsed message. Addresses may be `"Name <a@b.co>"`, bare emails, phone numbers (SMS) or arrays of them. Resend's `POST /emails` body is accepted as is. Wakes every waiting search at once. |
| `GET /__admin/outbox?to=&since=&server=&limit=` | Every stored message (`{id, to, createdAt, server, message}`), oldest first. `GET /__admin/outbox/:id` returns one. |
| `GET /__admin/outbox/:id/links` | `{id, links: [href…], codes: [value…]}`. |
| `GET` / `PUT /__admin/settings` | `{pollDelaysMs: [20]}`: the `x-ms-delay` sent while a search matches nothing. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`auth_failed` (401, SDK `authentication_error`), `rate_limited` (429 on search, SDK `api_error`),
`server_error` (500), `search_never_matches` (searches find nothing, so `messages.get` ends in
`search_timeout`), `slow_search` (2 s latency).

### Namespaces

The SDK cannot add headers, so a namespace can be chosen by API key:
`PUT /__admin/credentials {"credentials": {"<MAILOSAUR_API_KEY>": "<namespace>"}}`. Also
`x-mockingbird-namespace` or a `/ns/<name>` prefix for raw HTTP callers. Ingest into a namespace
with `x-mockingbird-namespace` (the Resend mock forwards with its own namespace name).

### Deliberately not modelled

- Real delivery: there is no SMTP listener. Mail arrives only through the ingest route,
  `messages.create`, or another mock's `--forward-to-inbox`.
- Servers, usage, devices (TOTP), previews, spam/deliverability analysis, forward and reply,
  and file downloads (attachment `url`s are placeholders; ingest keeps only attachment metadata).
- Mailosaur's exact code detector is not published. The mock's rule (standalone 4–8 digit runs,
  not inside URLs) reproduces it for our templates (Cognito's "Your verification code is
  {####}.").
- Server ids are not validated against an account; any 8-character id is an (empty) inbox.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `MailosaurAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `ingest(input)`, `messages()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, ingest). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `MAILOSAUR_PRESETS` | object | Every named fault preset. |
| `MAILOSAUR_NAMESPACE` | string | The service name, `"mailosaur"`. |
| `ANY_SERVER` | string | `"*"`: the server of mail ingested without one (visible from every server id). |
| `DEFAULT_AWAIT_TIMEOUT_MS`, `MAX_AWAIT_TIMEOUT_MS` | numbers | The `await` long-poll's default and maximum `timeout`. |
| `DEFAULT_SETTINGS` | object | `{pollDelaysMs: [20]}`. |
| `matchesCriteria` | function | Whether a message matches `{sentTo, sentFrom, subject, body, match}`. |
| `findCodes`, `htmlContent`, `textContent`, `parseAddresses` | functions | Mailosaur's parsing: codes, `{body, links, codes, images}` content, `Name <email>` / phone addresses. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`, plus `tls: true` for the HTTPS + CONNECT door (`tlsUrl`, `proxyUrl`, `cert`); the `serve` CLI target (`--tls-port`, `--tls-cert`, `--tls-key`, `--tls-cert-out`, `--poll-delay`); port 8793. |
| `selfSignedCertificate`, `CERTIFICATE_HOSTS` (`./server`) | Node | Generate the in-memory certificate the door presents, and the hosts it names. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
