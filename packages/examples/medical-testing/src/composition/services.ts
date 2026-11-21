/**
 * Every third-party service this app talks to, as the System screen lists them. `id` matches the
 * emulator's admin id and, for a service that can switch to its sandbox, the sandbox proxy's
 * provider id. `unsupported` says why a service stays emulated.
 */
export type SystemServiceEntry = {
  id: string
  label: string
  category: string
  unsupported?: string
}

export const SYSTEM_SERVICES: readonly SystemServiceEntry[] = [
  { id: "stripe", label: "Stripe", category: "Payments" },
  { id: "junction", label: "Junction", category: "Lab testing" },
  { id: "resend", label: "Resend", category: "Email" },
  { id: "twilio", label: "Twilio", category: "SMS and verification" },
  { id: "fcm", label: "Firebase Cloud Messaging", category: "Push notifications" },
  { id: "slack", label: "Slack", category: "Staff chat" },
  {
    id: "google",
    label: "Google sign-in",
    category: "Identity",
    unsupported: "Sign-in redirects can't be forwarded to a vendor sandbox",
  },
  {
    id: "apple",
    label: "Sign in with Apple",
    category: "Identity",
    unsupported: "Sign-in redirects can't be forwarded to a vendor sandbox",
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    category: "Database",
    unsupported: "Runs in this browser; there is no vendor sandbox",
  },
]
