import type { HostedFlowStep } from "./hostedFlow.js"

export type IdentityProviderKey = "google" | "apple"

export type IdentityProfile = {
  provider: IdentityProviderKey
  /** The provider's stable subject claim — the only safe identity key (email can change). */
  subject: string
  email: string | null
  name: string | null
  picture: string | null
}

/** A branded "Continue with {Google,Apple}" button talks to exactly this. */
export interface IdentityProvider {
  startSignIn(provider: IdentityProviderKey): Promise<HostedFlowStep<IdentityProfile>>
  continueSignIn(
    flowId: string,
    action: string,
    method: string,
    body: string,
  ): Promise<HostedFlowStep<IdentityProfile>>
}
