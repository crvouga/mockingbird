# @crvouga/mockingbird-service-twilio

Stateful mock of **Twilio** for test suites: Lookup v2 phone validation, Verify v2 phone OTP
(with the real state machine: wrong codes, attempt limits, 10-minute expiry on the mock clock),
Programmable Messaging with an outbox, and call Recordings. It also signs and posts Twilio's
inbound SMS and voice webhooks to your app. Every product is served on one port. A suite reads the
OTP from the admin plane instead of bypassing verification (`E2E_OTP_BYPASS_*`).

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/twilio/SUPPORT.md)
- The contract (`openapi.yaml`) is trimmed from Twilio's API reference to what our consumer
  calls. Lookup v2 responses are checked byte for byte against the live API
  (`scripts/parity.ts`, recorded in `test/fixtures/lookups.live.json`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-twilio
```

ESM only. Node >= 22 or Bun >= 1.2. Lookup validation uses `libphonenumber-js` (Twilio's
Lookup is libphonenumber). Serve it with `npx mockingbird-twilio serve`, with `createServer`
from `./server` (Node), or with `createRuntime` in any Fetch server.

## Usage

```bash
npx mockingbird-twilio serve --port 8798 \
  --app-url http://127.0.0.1:3000 \
  --public-base-url "$TWILIO_VOICE_WEBHOOK_BASE_URL" \
  --account-sid "$TWILIO_ACCOUNT_SID" --auth-token "$TWILIO_AUTH_TOKEN" \
  --caller-id "$TWILIO_VOICE_CALLER_ID"
```

### Pointing the app at it (G-T1)

twilio-node builds a host for each product (`api.twilio.com`, `verify.twilio.com`,
`lookups.twilio.com`). The mock takes that host as the first path segment:
`{mock}/api/2010-04-01/…`, `{mock}/verify/v2/…`, `{mock}/lookups/v2/…`. Pass every
`new Twilio(...)` an `httpClient` that rewrites the URL. `twilioMockUrl` does the rewrite:

```js
import { RequestClient, Twilio } from "twilio"
import { twilioMockUrl } from "@crvouga/mockingbird-service-twilio"

/** https://verify.twilio.com/v2/Services/VA…/Verifications → {base}/verify/v2/Services/VA…/Verifications */
class MockRequestClient extends RequestClient {
  constructor(baseUrl) {
    super()
    this.baseUrl = baseUrl
  }
  request(opts) {
    return super.request({ ...opts, uri: twilioMockUrl(opts.uri, this.baseUrl) })
  }
}

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env
const base = process.env.TWILIO_API_BASE_URL // e.g. http://127.0.0.1:8798
const client = new Twilio(
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  base ? { httpClient: new MockRequestClient(base) } : {},
)
```

The mock also routes by the `Host` header. A request that reaches it as `lookups.twilio.com`
(through a DNS override or a proxy) and has no prefix is served as `/lookups/…`. The recording
adapter's raw `fetch` of `https://api.twilio.com/2010-04-01/…` becomes
`twilioMockUrl(url, TWILIO_API_BASE_URL)`. `RecordingUrl` in webhooks keeps the canonical
`https://api.twilio.com` form that the adapter checks.

### Reading the OTP in a test

```ts
import { createRuntime } from "@crvouga/mockingbird-service-twilio"

const twilio = createRuntime()
// …the app calls verify.v2.services(VA).verifications.create({ to, channel: "sms" })…
const latest = await twilio.fetch(new Request("http://twilio.test/__admin/verify/+12025550123/latest"))
const { code, sid, status } = (await latest.json()) as { code: string; sid: string; status: string }
// …the app calls verificationChecks.create({ verificationSid: sid, code }) → status "approved"
```

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /lookups/v2/PhoneNumbers/{PhoneNumber}` | Validates the number the way the live API does (libphonenumber): `valid`, `validation_errors` (`TOO_SHORT`, `TOO_LONG`, `INVALID_BUT_POSSIBLE`, `INVALID_COUNTRY_CODE`, `INVALID_LENGTH`, `NOT_A_NUMBER`), `phone_number`, `national_format`, `calling_country_code`, `country_code`, `url`. Every data package is `null`. A national number with no `CountryCode` must be a valid US number, otherwise the answer is `INVALID_COUNTRY_CODE`. Fictional 555-01xx numbers are valid. |
| `POST /verify/v2/Services/{VA}/Verifications` | `To` (valid E.164, or an email for `Channel=email`), `Channel`, optional `CustomCode`. Creates a `VE…` verification with a 6-digit code (or `fixedCode`). Sending again to the same pending verification keeps its sid and code and adds a `send_code_attempts` entry. The 6th send to one number within 10 minutes is 429 `60203`. A bad `To` is 400 `60200`. An unknown service sid (not `VA` + 32 hex) is 404 `20404`. |
| `POST /verify/v2/Services/{VA}/VerificationCheck` | `Code` plus `VerificationSid` or `To`. The right code returns 200 `approved`, `valid: true`. A wrong code returns 200 `pending` and counts an attempt. The 6th check is 429 `60202`. A missing, approved, canceled or expired (10 minutes on the mock clock) verification is 404 `20404`. |
| `GET` / `POST /verify/v2/Services/{VA}/Verifications/{VE}` | Fetches a verification, or sets `Status=canceled\|approved` on one. |
| `POST /api/2010-04-01/Accounts/{AC}/Messages.json` | `To`, `Body` or `MediaUrl`, and `From` or `MessagingServiceSid`. Returns 201 with an `SM…` sid (`MM…` with media), status `queued` (or `accepted` through a Messaging Service), and RFC 2822 dates. Errors: 21604 (no To), 21602 (no Body), 21603 (no From), 21211 (invalid To), 21617 (over 1600 characters). The message is recorded in the outbox. |
| `GET /api/2010-04-01/Accounts/{AC}/Messages/{SM}.json` | Reads a message back. |
| `GET /api/2010-04-01/Accounts/{AC}/Recordings/{RE}.wav` | The recording as a RIFF WAV. With `RequestedChannels=2` you get both channels. Otherwise a dual-channel recording is mixed down to mono, as Twilio does. |
| `GET` / `DELETE /api/2010-04-01/Accounts/{AC}/Recordings/{RE}.json` | Metadata, or a delete (204; a second delete is 404, which our consumer tolerates). |

Errors use Twilio's body, `{code, message, more_info, status}`, with `X-Twilio-Error-Code`.
Authentication is HTTP Basic: an `AC…` (or `SK…`) username and a non-empty password. With
`accounts` (or `--account-sid` plus `--auth-token`) only those pairs are accepted. A missing or
wrong credential is 401 `20003`. For a wrong token the message matches the live one:
`authentication failed, auth token is not valid for account AC…`.

### Webhooks (S8.4)

The mock signs inbound webhooks with `X-Twilio-Signature`. The signature is base64
HMAC-SHA1(auth token, public URL + sorted `key+value` params), the same computation as
`twilio.validateRequest`. It signs against the **public base URL the app is configured with**
(`--public-base-url`, i.e. `TWILIO_VOICE_WEBHOOK_BASE_URL`), not the localhost address it posts
to. Twilio does not retry these webhooks, so the mock sends each one once.

| Trigger | Posts to | Payload |
| --- | --- | --- |
| `POST /__admin/inbound/sms {from, body, to?, media?, messageSid?, params?}` | `/messaging/inbound/sms` | `MessageSid`/`SmsSid` (`SM…`, or `MM…` with media), `AccountSid`, `From`, `To` (default: `--caller-id`), `Body`, `NumMedia`, `MediaUrl{i}`, `MediaContentType{i}`, `SmsStatus=received`, … |
| `POST /__admin/voice/twiml` | `/admin/messaging/voice/twiml` | `CallSid`, `From=client:<uuid>`, `To`, `CallStatus=ringing` plus the body's fields (e.g. `conversationId`) |
| `POST /__admin/voice/disclosure` | `/admin/messaging/voice/disclosure` | `CallSid`, `CallStatus=in-progress` |
| `POST /__admin/voice/status` | `/admin/messaging/voice/status` | `CallSid`, `CallStatus=completed`, `CallDuration` |
| `POST /__admin/voice/recording` | `/admin/messaging/voice/recording` | `RecordingSid`, canonical `RecordingUrl`, `RecordingStatus=completed`, `RecordingDuration`, `RecordingChannels=2`. It also stores a dual-channel WAV so the download works. |

Every body field overrides a default. The admin answer lists each delivery with the app's status
and response body (e.g. `<Response/>`). Event types for `PUT /__admin/webhook-endpoints`
filters are `sms.inbound` and `voice.{twiml,disclosure,status,recording}`.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/verify/:e164/latest` | `{code, sid, status, to, channel, serviceSid, attempts, sendAttempts, createdAt, expiresAt}` for the newest verification to that number. This is how a test reads the OTP. |
| `GET` / `PUT /__admin/verify` | `{fixedCode: "000000" \| null, ttlSeconds, maxCheckAttempts, maxSendAttempts, sendWindowSeconds}` for the calling namespace. |
| `PUT /__admin/lookups/:e164` | `{valid, validationErrors?}` overrides Lookup for that number (Verify and Messages use it too). `DELETE` removes the override. |
| `PUT /__admin/recordings/:RE` | Uploads a recording: a raw WAV body (`content-type: audio/wav`), `{"wavBase64": …}`, or `{channels?, seconds?}` for a synthesised 8 kHz 16-bit tone. |
| `GET /__admin/outbox?to=&since=&kind=sms\|verify` | Everything "sent": SMS (`{to, from, messagingServiceSid, body, sid}`) and every Verify code delivery (`{code, body: "Your verification code is: …"}`). |
| `GET /__admin/messages` | Message resources in the namespace. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; list them with `GET /__admin/faults/presets`):
`verify_5xx` (start and check answer 500 `20500`), `sms_socket_drop` (Messages.json drops the
connection, an unknown outcome), `sms_4xx` (400 `21211`), `lookup_5xx` (503 `20503`; the EMR
fails open), `webhook_duplicate`, `webhook_drop`.

### Namespaces

The Twilio SDK cannot add headers, so a suite picks a namespace by **AccountSid**:
`PUT /__admin/credentials {"credentials": {"<TWILIO_ACCOUNT_SID>": "<namespace>"}}`. A namespace
can also come from the `x-mockingbird-namespace` header or a `/ns/<name>` prefix on the base URL
(`twilioMockUrl` keeps the prefix).

### Deliberately not modelled

- Delivery: messages stay `queued`/`accepted`, no status callbacks are sent (our consumer sets no
  `statusCallback`), and no voice calls, conferences or media streams happen.
- Paid Lookup data packages (`Fields=line_type_intelligence`, `caller_name`, …) are always
  `null`.
- Verify channels other than SMS are accepted and recorded, but nothing is delivered. Verify
  Service configuration (code length, friendly name, rate-limit buckets) is global, set with
  `PUT /__admin/verify`.
- "Sent, then the socket dropped": `sms_socket_drop` drops before the message is recorded.
- Accounts: any `AC…` sid is its own account, and the path's `{AccountSid}` is not
  cross-checked against the credential.
- libphonenumber-js drops "local only" lengths from its metadata. The mock restores them for
  NANP (7) and GB (4–6, 8), which is enough for the fictional numbers tests use. Other countries
  may answer `TOO_SHORT` where Twilio answers `INVALID_BUT_POSSIBLE`.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `TwilioAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `latestVerification(to)`, `resolveLookup(raw, country?)`, `setLookup(e164, override)`, `putRecording(sid, input)`, `outbox()`, `messages()`. Options: `sqlite`, `now`, `namespace`, `verify`, `accounts`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, outbox, webhooks), plus host routing. Options: `app: {url, publicBaseUrl?, authToken, accountSid?, callerId?, messagingServiceSid?}`, `verify`, `accounts`, `retryDelaysMs`, `fetch`, `clock`, `seed`, `adminKey`, `onLog`. The returned runtime also has `inboundSms(input)` and `voiceWebhook(kind, params)`. |
| `TWILIO_PRESETS` | object | Every named fault preset. |
| `TWILIO_WEBHOOK_EVENTS` | object | Webhook event type → the app path it posts to. |
| `twilioMockUrl` | function | Rewrites an upstream `https://<product>.twilio.com/…` URL onto a mock base URL (for the G-T1 `httpClient`). |
| `TWILIO_PRODUCTS` | array | The product prefixes served: `api`, `verify`, `lookups`. |
| `lookup` | function | Lookup v2 validation of a raw input (optionally in a `CountryCode` region). |
| `e164Key` | function | `+` and digits: the key that admin overrides use. |
| `twilioError` | function | A Twilio error response, `{code, message, more_info, status}`. |
| `DEFAULT_VERIFY_SETTINGS` | object | Verify defaults: 10-minute expiry, 5 checks, 5 sends per 10 minutes, random codes. |
| `DEFAULT_ACCOUNT_SID` | string | The account used when the credential is an API key. |
| `TWILIO_NAMESPACE` | string | The service name, `"twilio"`. |
| `synthesizeWav`, `readWav`, `mixDownToMono` | functions | Make a PCM WAV, read its format, mix a multi-channel WAV down to mono. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8798. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
