# @crvouga/mockingbird-credentials

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Loads third-party sandbox credentials for live parity runs from the environment, plus helpers to scrub those secrets from logs. Locally the environment is `.env.local` (Bun loads it automatically). In GitHub Actions it is repository secrets exposed as env vars (see [docs/SECRETS.md](https://github.com/crvouga/mockingbird/blob/main/docs/SECRETS.md)). Use it in a live-parity script before calling `parity(...)` from [`@crvouga/mockingbird-parity`](https://github.com/crvouga/mockingbird/tree/main/packages/parity/runner). You do not need it for self-parity tests.

No dependencies and no filesystem access. ESM only, Node >= 22 or Bun >= 1.2.

## Usage

```ts
import { createRedactor, leaks, loadCredentials } from "@crvouga/mockingbird-credentials"

const credentials = await loadCredentials(
  {
    provider: "stripe",
    // secret field name -> env var that supplies it
    fields: { MOCKINGBIRD_STRIPE_SECRET_KEY: "MOCKINGBIRD_STRIPE_SECRET_KEY" },
  },
  { env: process.env },
)
const secretKey = credentials.values.MOCKINGBIRD_STRIPE_SECRET_KEY

// Pass as `redact` to parity(...) so failure reports never print the key.
const redact = createRedactor(credentials.secrets)
console.log(redact(`Authorization: Bearer ${secretKey}`)) // "Authorization: Bearer <redacted>"
console.log(leaks(redact(secretKey), credentials.secrets)) // false
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `loadCredentials` | `<F extends string>(spec: CredentialSpec<F>, options: { env }) => Promise<LoadedCredentials<F>>` | Reads every field's env var (trimmed, non-blank). Returns `{ values: Record<F, string>, secrets }`. Throws `CredentialError` naming the provider and each missing env var. |
| `credentialsFromEnv` | `<F>(spec, env) => Record<F, string> \| undefined` | The same resolution without throwing; `undefined` if any field is missing. |
| `createRedactor` | `(secrets: readonly string[]) => (text: string) => string` | Replace every secret with `REDACTED`, longest first. Secrets shorter than 4 characters are ignored. |
| `leaks` | `(text, secrets) => boolean` | True if `text` still contains any secret of length >= 4. |
| `REDACTED` | `"<redacted>"` | Replacement string. |
| `CredentialError` | `class extends Error` | A required env var is missing or blank. |

Exported types: `CredentialSpec<F>` (`{ provider; fields: Record<F, envVarName> }`), `LoadCredentialsOptions` (`{ env }`), `LoadedCredentials<F>`, `Env` (`Record<string, string | undefined>`).

## Related

- [`@crvouga/mockingbird-parity`](https://github.com/crvouga/mockingbird/tree/main/packages/parity/runner): pass `createRedactor(credentials.secrets)` as its `redact` option.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
