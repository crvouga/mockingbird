import { accountOfKey } from "./account.js"
import { isApiVersion } from "./version.js"

/**
 * One Stripe account the mock stands in for. Several keys may act as the same account: our
 * backend's legacy `STRIPE_API_KEY` and `STRIPE_MSO_API_KEY` are both the MSO account and must
 * share state, and the EMR key maps to MSO unless configured otherwise.
 */
export type AccountConfig = {
  /** The account id, e.g. `acct_mso`. Webhook endpoints are tagged with it. */
  id: string
  /** Secret, restricted and publishable keys that act as this account. */
  keys: string[]
  /** Version for requests without `Stripe-Version` and for webhook payloads. */
  apiVersion?: string
  /** `{ "<receiver url>": "whsec_…" }`: endpoints receiving every event of this account. */
  webhookSecrets?: Record<string, string>
  /** Seed the recorded catalog (products, prices, coupons, promotion codes) into this account. */
  corpus?: boolean
  /** `business_profile.name` / `settings.dashboard.display_name` on `GET /v1/account`. */
  displayName?: string
}

/** Default version of webhook payloads: the one every backend receiver of ours pins. */
export const DEFAULT_WEBHOOK_API_VERSION = "2024-06-20"

const KEY = /^(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_]+$/

export const validateAccounts = (value: unknown): AccountConfig[] | string => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { accounts?: unknown }).accounts)
      ? (value as { accounts: unknown[] }).accounts
      : undefined
  if (list === undefined)
    return 'expected {"accounts": [{"id": "acct_mso", "keys": ["sk_test_…"]}]}'
  const accounts: AccountConfig[] = []
  const seenKeys = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return "each account is an object"
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== "string" || !/^acct_[A-Za-z0-9_]{1,64}$/.test(raw.id))
      return "each account needs an id like acct_mso"
    if (
      !Array.isArray(raw.keys) ||
      raw.keys.some((key) => typeof key !== "string" || !KEY.test(key))
    )
      return `${raw.id}: keys must be Stripe API keys (sk_test_…, rk_test_…, pk_test_…)`
    for (const key of raw.keys as string[]) {
      if (seenKeys.has(key)) return `${raw.id}: a key may belong to only one account`
      seenKeys.add(key)
    }
    if (
      raw.apiVersion !== undefined &&
      (typeof raw.apiVersion !== "string" || !isApiVersion(raw.apiVersion))
    )
      return `${raw.id}: apiVersion must look like 2024-06-20 or 2025-02-24.acacia`
    const secrets = raw.webhookSecrets
    if (
      secrets !== undefined &&
      (typeof secrets !== "object" ||
        secrets === null ||
        Object.values(secrets).some((secret) => typeof secret !== "string"))
    )
      return `${raw.id}: webhookSecrets must map receiver URLs to whsec_ secrets`
    accounts.push({
      id: raw.id,
      keys: raw.keys as string[],
      ...(typeof raw.apiVersion === "string" ? { apiVersion: raw.apiVersion } : {}),
      ...(secrets ? { webhookSecrets: secrets as Record<string, string> } : {}),
      ...(raw.corpus === true ? { corpus: true } : {}),
      ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}),
    })
  }
  return accounts
}

/**
 * Which account a key acts as. Configured keys resolve to their account; any other test key is
 * an account of its own (an opaque id derived from the key), so two unconfigured keys never
 * see each other's objects.
 */
export class AccountDirectory {
  private accounts: AccountConfig[] = []
  private readonly byKey = new Map<string, AccountConfig>()
  private readonly listeners = new Set<() => void>()

  constructor(accounts: readonly AccountConfig[] = []) {
    this.configure(accounts)
  }

  configure(accounts: readonly AccountConfig[]): void {
    this.accounts = [...accounts]
    this.byKey.clear()
    for (const account of accounts) for (const key of account.keys) this.byKey.set(key, account)
    for (const listener of this.listeners) listener()
  }

  /** Called whenever the configuration changes (the runtime re-derives webhook endpoints). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): AccountConfig[] {
    return [...this.accounts]
  }

  config(id: string): AccountConfig | undefined {
    return this.accounts.find((account) => account.id === id)
  }

  /** The configured account for a key, if any. */
  configFor(key: string): AccountConfig | undefined {
    return this.byKey.get(key)
  }

  /** The account id a key acts as. */
  accountFor(key: string): string {
    return this.byKey.get(key)?.id ?? accountOfKey(key)
  }

  /** Accepts both an account id and a key (so admin payloads can name either). */
  resolve(accountOrKey: string): string {
    return KEY.test(accountOrKey) ? this.accountFor(accountOrKey) : accountOrKey
  }
}
