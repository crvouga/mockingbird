import { html } from "htm/preact"

/**
 * Cove's mark: an original abstract wave-over-drop motif (two overlapping
 * arcs), not modeled on any real company's logo. Used in the nav, sign-in
 * screen, and landing page.
 */
export const Logo = ({ tagline = false }: { tagline?: boolean }) => html`
  <span class="cove-logo">
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="14" r="13" fill="#0b3d3a" />
      <path
        d="M6 16.5c2-2.2 4-2.2 6 0s4 2.2 6 0"
        stroke="#faf7f0"
        stroke-width="2"
        stroke-linecap="round"
        fill="none"
      />
      <path
        d="M6 11.5c2-2.2 4-2.2 6 0s4 2.2 6 0"
        stroke="#1a8f85"
        stroke-width="2"
        stroke-linecap="round"
        fill="none"
        opacity="0.9"
      />
    </svg>
    <span>
      <span class="cove-logo-word">Cove</span>
      ${tagline && html`<span class="cove-logo-tagline">Lab testing, made calm.</span>`}
    </span>
  </span>
`
