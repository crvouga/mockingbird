import { html } from "htm/preact"

const GoogleIcon = () => html`
  <svg class="cove-oauth-icon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.08-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"
    />
  </svg>
`

const AppleIcon = () => html`
  <svg class="cove-oauth-icon" width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
    <path
      fill="currentColor"
      d="M13.1 9.5c0-2.1 1.7-3.1 1.8-3.2-1-1.4-2.5-1.6-3-1.6-1.3-.1-2.5.7-3.1.7-.6 0-1.6-.7-2.7-.7C4.6 4.7 3.3 5.4 2.6 6.5c-1.5 2.5-.4 6.3 1.1 8.3.7 1 1.6 2.1 2.7 2.1 1.1 0 1.5-.7 2.8-.7s1.7.7 2.8.7c1.2 0 1.9-1 2.6-2 .8-1.2 1.2-2.4 1.2-2.4-.1 0-2.6-1-2.6-3zM10.9 3.1c.6-.7 1-1.7.9-2.7-.9.1-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 1.9-.5 2.5-1.2z"
    />
  </svg>
`

export const GoogleButton = ({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) => html`
  <button class="cove-oauth-btn cove-oauth-btn-google" onClick=${onClick} disabled=${disabled}>
    <${GoogleIcon} />
    <span>Continue with Google</span>
  </button>
`

export const AppleButton = ({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) => html`
  <button class="cove-oauth-btn cove-oauth-btn-apple" onClick=${onClick} disabled=${disabled}>
    <${AppleIcon} />
    <span>Continue with Apple</span>
  </button>
`
