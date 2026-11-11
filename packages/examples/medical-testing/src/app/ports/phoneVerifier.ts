import type { TextChannel } from "../model.js"

export type PhoneVerificationStart = "sent" | "invalid_number" | "too_many_requests"
export type PhoneVerificationCheck = "approved" | "incorrect" | "expired" | "too_many_attempts"

/**
 * Proves a member holds a phone number, shaped after a hosted verification
 * API (Twilio Verify and similar): the provider generates, delivers, expires
 * and rate-limits the one-time code, so the app never stores it.
 */
export interface PhoneVerifier {
  start(input: { to: string; channel: TextChannel }): Promise<PhoneVerificationStart>
  check(input: { to: string; code: string }): Promise<PhoneVerificationCheck>
}
