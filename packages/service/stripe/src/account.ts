import { opaqueToken } from "@crvouga/mockingbird-service"

/**
 * Real Stripe partitions objects by account; the mock partitions by the bearer key that created
 * them, so two different test keys are two accounts and a PC object is `resource_missing` on the
 * MSO account. The key itself is never stored — only this deterministic, opaque token.
 */
export const accountOfKey = (key: string) => `acct_${opaqueToken(key, 8)}`

export const accountOf = (request: Request): string => {
  const authorization = request.headers.get("authorization")
  const match = authorization === null ? null : /^Bearer\s+(\S+)$/.exec(authorization)
  return accountOfKey(match?.[1] ?? "")
}
