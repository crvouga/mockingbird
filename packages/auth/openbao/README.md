# @crvouga/mockingbird-openbao

Loads third-party sandbox credentials for live parity runs from the environment or from an [OpenBao](https://openbao.org/) / HashiCorp Vault KV v2 secret (token or JWT/OIDC login), plus helpers to scrub those secrets from logs. Use it in a live-parity script before calling `parity(...)` from [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity). You do not need it for self-parity tests, or if you already have credentials in env and handle redaction yourself.

## Install

```bash
npm install -D @crvouga/mockingbird-openbao
```

No dependencies and no filesystem access (you inject the token-file reader). ESM only, Node >= 22 or Bun >= 1.2.

## Usage

```ts
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRedactor, leaks, loadCredentials } from "@crvouga/mockingbird-openbao"

const credentials = await loadCredentials(
  {
    provider: "stripe",
    // secret field name -> env var that can supply it directly
    fields: { MOCKINGBIRD_STRIPE_SECRET_KEY: "MOCKINGBIRD_STRIPE_SECRET_KEY" },
  },
  {
    env: process.env,
    readTokenFile: () => readFile(join(homedir(), ".vault-token"), "utf8").catch(() => undefined),
  },
)
const secretKey = credentials.values.MOCKINGBIRD_STRIPE_SECRET_KEY
console.log(`credentials from ${credentials.source}`) // "env" or "openbao"

// Pass as `redact` to parity(...) so failure reports never print the key or the Vault token.
const redact = createRedactor(credentials.secrets)
console.log(redact(`Authorization: Bearer ${secretKey}`)) // "Authorization: Bearer <redacted>"
console.log(leaks(redact(secretKey), credentials.secrets)) // false
```

## Resolution order

`loadCredentials(spec, { env, fetch?, readTokenFile? })`:

1. If every field's env var is set (non-blank), use them (`source: "env"`).
2. Otherwise read the KV v2 secret at `MOCKINGBIRD_OPENBAO_PATH_<PROVIDER>` (provider upper-cased, non-alphanumerics -> `_`), else `spec.defaultPath`, else `secret/data/secret`, from the server at `MOCKINGBIRD_OPENBAO_ADDR` / `BAO_ADDR` / `VAULT_ADDR`, else `DEFAULT_OPENBAO_ADDRESS`. Authentication, first match wins:
   - `MOCKINGBIRD_OPENBAO_TOKEN` / `BAO_TOKEN` / `VAULT_TOKEN`;
   - `MOCKINGBIRD_OPENBAO_JWT` (e.g. a GitHub Actions OIDC token), exchanged at mount `MOCKINGBIRD_OPENBAO_JWT_MOUNT` (default `jwt`) for role `MOCKINGBIRD_OPENBAO_JWT_ROLE` (default `mockingbird-parity`); that token is revoked after the read;
   - the string returned by `readTokenFile()`.

   Each secret field must exist (by field name, not env var name) and be non-empty.
3. `MOCKINGBIRD_CREDENTIALS=env` or `=openbao` forces one source; any other value than `env`, `openbao`, `auto` throws.

Failures throw `CredentialError` or `OpenBaoError` with the provider, expected fields, env vars and the exact secret URL in the message. Note that `DEFAULT_OPENBAO_ADDRESS` is the Mockingbird maintainer's server; set `MOCKINGBIRD_OPENBAO_ADDR` (or `VAULT_ADDR`) to your own.

## API

| Export | Signature | Description |
| --- | --- | --- |
| `loadCredentials` | `<F extends string>(spec: CredentialSpec<F>, options: LoadCredentialsOptions) => Promise<LoadedCredentials<F>>` | See resolution order above. Returns `{ values: Record<F, string>, source: "env" \| "openbao", secrets }`; `secrets` includes any OpenBao token used. |
| `credentialsFromEnv` | `<F>(spec, env) => Record<F, string> \| undefined` | Env-only resolution (trimmed); `undefined` if any field is missing. |
| `createRedactor` | `(secrets: readonly string[]) => (text: string) => string` | Replace every secret with `REDACTED`, longest first. Secrets shorter than 4 characters are ignored. |
| `leaks` | `(text, secrets) => boolean` | True if `text` still contains any secret of length >= 4. |
| `REDACTED` | `"<redacted>"` | Replacement string. |
| `OpenBaoClient` | `new OpenBaoClient({ address, fetch?, namespace? })` | Minimal HTTP client. `address` must be `https:` (or `localhost` / `127.0.0.1`). Methods: `loginWithJwt({ jwt, role, mount? })` -> `{ token, leaseDurationSeconds? }`, `readKv2(token, path)` -> string fields of the secret (`path` is the full API path, e.g. `secret/data/foo`), `revokeSelf(token)` (best effort). `namespace` is sent as `X-Vault-Namespace`. |
| `OpenBaoError` | `class extends Error { status; errors: string[]; operation }` | Non-2xx response or malformed login/secret body. |
| `CredentialError` | `class extends Error` | Missing credentials, missing secret field, or bad `MOCKINGBIRD_CREDENTIALS`. |
| `DEFAULT_OPENBAO_ADDRESS` | `"https://vault.chrisvouga.dev"` | Fallback server address. |
| `DEFAULT_JWT_MOUNT` | `"jwt"` | Fallback JWT auth mount. |
| `DEFAULT_JWT_ROLE` | `"mockingbird-parity"` | Fallback JWT role. |

Exported types: `CredentialSpec<F>` (`{ provider; fields: Record<F, envVarName>; defaultPath? }`), `LoadCredentialsOptions` (`{ env; fetch?; readTokenFile? }`), `LoadedCredentials<F>`, `Env` (`Record<string, string | undefined>`), `FetchLike`, `OpenBaoClientOptions`.

## Related

- [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) — pass `createRedactor(credentials.secrets)` as its `redact` option.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
