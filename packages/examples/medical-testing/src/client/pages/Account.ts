import { html } from "htm/preact"
import type { User } from "../api.js"

const PROVIDER_LABEL: Record<string, string> = { google: "Google", apple: "Apple" }

export const Account = ({ user, onSignOut }: { user: User; onSignOut: () => void }) => html`
  <div class="cove-card" style="max-width:480px">
    <span class="cove-eyebrow">Account</span>
    <h1>Your profile</h1>
    <div class="cove-account-row">
      <span class="cove-account-label">Avatar</span>
      <span class="cove-avatar" style="width:40px;height:40px">
        ${user.picture ? html`<img src=${user.picture} alt="" />` : (user.name?.[0] ?? "?").toUpperCase()}
      </span>
    </div>
    <div class="cove-account-row">
      <span class="cove-account-label">Name</span>
      <span>${user.name ?? "Not shared"}</span>
    </div>
    <div class="cove-account-row">
      <span class="cove-account-label">Email</span>
      <span>${user.email ?? "Not shared"}</span>
    </div>
    <div class="cove-account-row">
      <span class="cove-account-label">Signed in with</span>
      <span>${PROVIDER_LABEL[user.provider] ?? user.provider}</span>
    </div>
    <button class="cove-btn cove-btn-ghost" style="margin-top:1.25rem" onClick=${onSignOut}>Sign out</button>
  </div>
`
