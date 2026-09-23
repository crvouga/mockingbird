import { html } from "htm/preact"
import { useState } from "preact/hooks"
import type { OAuthProvider, User } from "../api.js"
import { IconFlask, IconNote, IconShield } from "../components/Icons.js"
import { Logo } from "../components/Logo.js"
import { AppleButton, GoogleButton } from "../components/OAuthButtons.js"
import { OAuthModal } from "../components/OAuthModal.js"

const VALUE_PROPS = [
  {
    icon: IconFlask,
    title: "Order in minutes",
    body: "Pick a panel, check out, done — no clinic visit required.",
  },
  {
    icon: IconShield,
    title: "Runs entirely in your browser",
    body: "Everything happens in this tab — nothing you do here touches a real server.",
  },
  {
    icon: IconNote,
    title: "Results you can read",
    body: "A plain-language summary, not just a PDF full of jargon.",
  },
]

export const Landing = ({ onSignedIn }: { onSignedIn: (user: User) => void }) => {
  const [modalProvider, setModalProvider] = useState<OAuthProvider | null>(null)

  return html`
    <div class="cove-landing">
      <div class="cove-hero-badge" aria-hidden="true">
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
          <circle cx="36" cy="36" r="34" fill="#0b3d3a" />
          <circle cx="36" cy="36" r="34" fill="url(#cove-hero-gradient)" opacity="0.35" />
          <path d="M14 40c4-6 8-6 12 0s8 6 12 0 8-6 12 0" stroke="#faf7f0" stroke-width="3" stroke-linecap="round" fill="none" />
          <path d="M14 29c4-6 8-6 12 0s8 6 12 0 8-6 12 0" stroke="#ef7a5a" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.9" />
          <defs>
            <linearGradient id="cove-hero-gradient" x1="0" y1="0" x2="72" y2="72" gradientUnits="userSpaceOnUse">
              <stop stop-color="#1a8f85" />
              <stop offset="1" stop-color="#ef7a5a" stop-opacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <${Logo} />
      <h1>Lab testing, made calm.</h1>
      <p class="cove-landing-sub">
        Sign in, shop lab tests, check out, and get results — all in one place.
      </p>

      <div class="cove-value-props">
        ${VALUE_PROPS.map(
          (item) => html`
            <div class="cove-value-prop">
              <div class="cove-value-prop-icon"><${item.icon} /></div>
              <h3>${item.title}</h3>
              <p>${item.body}</p>
            </div>
          `,
        )}
      </div>

      <div class="cove-signin-box">
        <${GoogleButton} onClick=${() => setModalProvider("google")} />
        <${AppleButton} onClick=${() => setModalProvider("apple")} />
      </div>

      ${
        modalProvider &&
        html`<${OAuthModal}
        provider=${modalProvider}
        onClose=${() => setModalProvider(null)}
        onDone=${(user: User) => {
          setModalProvider(null)
          onSignedIn(user)
        }}
      />`
      }

      <p class="cove-disclaimer">
        This runs entirely in your browser, with nothing sent to a real server — an example
        built with <a href="/examples">Mockingbird</a>.
      </p>
    </div>
  `
}
