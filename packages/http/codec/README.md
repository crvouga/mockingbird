# @crvouga/mockingbird-http-codec

Content-type codecs used by Mockingbird's mock servers and differential runner: JSON, and
Rails/PHP/Stripe-style bracket notation for `application/x-www-form-urlencoded` bodies and query
strings (`address[city]=Paris`, `tags[]=x`, `items[0][name]=a`). Use it to encode requests for, or
decode requests to, form-encoded APIs such as Stripe. You do not need it to use a provider mock.

## Install

```bash
npm install @crvouga/mockingbird-http-codec
```

ESM only, portable (Node >=22, Bun >=1.2, browsers, workers). No dependencies.

## Usage

```ts
import {
  decodeForm,
  encodeBody,
  encodeForm,
  FORM_MEDIA_TYPE,
  readBody,
} from "@crvouga/mockingbird-http-codec"

const form = encodeForm({ email: "a@b.c", metadata: { plan: "pro" }, tags: ["x", "y"] })
console.log(form) // email=a%40b.c&metadata%5Bplan%5D=pro&tags%5B0%5D=x&tags%5B1%5D=y

// Decoding yields only strings, arrays and plain objects; coercing types is up to you.
console.log(decodeForm("?amount=100&items[0][price]=p_1&tags[]=a&tags[]=b"))
// { amount: "100", items: [{ price: "p_1" }], tags: ["a", "b"] }

// Build a request body for a media type, then decode any Request/Response by its content-type.
const { contentType, body } = encodeBody(FORM_MEDIA_TYPE, { amount: 100, currency: "usd" })
const request = new Request("https://mock.local/v1/charges", {
  method: "POST",
  headers: { "content-type": contentType },
  body,
})
const decoded = await readBody(request)
if (decoded.kind === "form") console.log(decoded.value.amount) // "100"
else if (decoded.kind === "invalid") console.error(decoded.error)
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `encodeForm` | `(value: Record<string, unknown>) => string` | Bracket-notation `x-www-form-urlencoded` string. |
| `encodeFormPairs` | `(value: Record<string, unknown>) => Array<[string, string]>` | Same, as unencoded key/value pairs. |
| `decodeForm` | `(text: string) => FormObject` | Decode a body or query string (leading `?` allowed). |
| `decodeFormPairs` | `(pairs: Iterable<[string, string]>) => FormObject` | Decode already percent-decoded pairs, e.g. `url.searchParams.entries()`. |
| `mediaTypeOf` | `(contentType: string \| null \| undefined) => string \| undefined` | Lower-cased media type without parameters. |
| `decodeBody` | `(contentType, bytes: Uint8Array) => DecodedBody` | Decode bytes by content-type. Never throws. |
| `readBody` | `(message: Request \| Response) => Promise<DecodedBody>` | Read the body and `decodeBody` it (consumes the body). |
| `encodeBody` | `(mediaType: string, value: unknown) => EncodedBody` | Encode for JSON, form or `text/*`; throws `TypeError` otherwise. |
| `JSON_MEDIA_TYPE` | `"application/json"` | |
| `FORM_MEDIA_TYPE` | `"application/x-www-form-urlencoded"` | |

Types:

- `DecodedBody`: `{ kind: "empty" }` (zero bytes) | `{ kind: "json"; value }` | `{ kind: "form"; value }`
  | `{ kind: "text"; value: string }` | `{ kind: "bytes"; value: Uint8Array }` (no or unknown
  content-type) | `{ kind: "invalid"; mediaType; text; error }` (malformed JSON).
- `EncodedBody`: `{ contentType: string; body: string }`.
- `FormValue`: `string | FormValue[] | { [key: string]: FormValue }`; `FormObject`: `{ [key: string]: FormValue }`.

Encoding rules (lossy by design, matching Stripe): numbers and booleans become strings, `null` and
empty arrays/objects encode as `key=` (how Stripe unsets a field), `undefined` keys are dropped,
and arrays always use explicit indices (`a[0]`). JSON detection accepts `application/json`,
`text/json` and any `+json` suffix. On decode, sparse indices are compacted (`a[2]=x` gives `["x"]`)
and `__proto__` keys become plain own properties (no prototype pollution).

## Related

- `@crvouga/mockingbird-service`: uses this codec to hand operation handlers decoded bodies and queries.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
