/**
 * Cove's design system, as plain CSS text so it can be inlined by both run
 * modes: `build-client.ts` embeds it in the standalone dev server's HTML
 * shell, and `src/browser.ts` injects it as a `<style>` element scoped
 * under `.cove-app` when mounted inline on the docs site (so it never
 * leaks into or collides with the docs site's own `global.css`).
 *
 * System fonts only, deliberately — this whole app makes a point of never
 * making a real network call, and a web-font request would be one.
 */
export const STYLES = `
.cove-app {
  --cove-ink: #16211f;
  --cove-brand: #0b3d3a;
  --cove-primary: #12766e;
  --cove-primary-hover: #1a8f85;
  --cove-accent: #ef7a5a;
  --cove-accent-hover: #e5673f;
  --cove-bg: #faf7f0;
  --cove-panel: #f2ecdf;
  --cove-surface: #ffffff;
  --cove-border: #e2ddd0;
  --cove-muted: #4b5a57;
  --cove-danger: #b3492f;
  --cove-danger-bg: #fbeae4;
  --cove-success: #2f7d5a;
  --cove-success-bg: #e7f3ea;
  --cove-warn: #a87316;
  --cove-warn-bg: #faf1de;
  --cove-radius-sm: 10px;
  --cove-radius: 14px;
  --cove-radius-lg: 20px;
  --cove-shadow: 0 1px 2px rgba(11, 61, 58, 0.06), 0 8px 24px -12px rgba(11, 61, 58, 0.18);
  --cove-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  all: initial;
  display: block;
  font-family: var(--cove-font);
  color: var(--cove-ink);
  background: var(--cove-bg);
  height: 100%;
  overflow-y: auto;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.cove-app *,
.cove-app *::before,
.cove-app *::after { box-sizing: border-box; }

.cove-app a { color: inherit; }
.cove-app button { font-family: inherit; }

.cove-shell { min-height: 100%; display: flex; flex-direction: column; }

/* ---- Top nav ---- */
.cove-nav {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.9rem 1.5rem;
  border-bottom: 1px solid var(--cove-border);
  background: var(--cove-surface);
  position: sticky;
  top: 0;
  z-index: 10;
}
.cove-nav-links { display: flex; align-items: center; gap: 0.25rem; }
.cove-nav-link {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--cove-muted);
  text-decoration: none;
  padding: 0.5rem 0.75rem;
  border-radius: var(--cove-radius-sm);
}
.cove-nav-link:hover { background: var(--cove-panel); color: var(--cove-ink); }
.cove-nav-link.is-active { color: var(--cove-brand); background: var(--cove-panel); }
.cove-spacer { flex: 1; }
.cove-nav-user {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0.25rem 0.75rem 0.25rem 0.25rem;
  cursor: pointer;
}
.cove-nav-user:hover { border-color: var(--cove-border); }
.cove-avatar {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: var(--cove-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.8rem;
  overflow: hidden;
  flex-shrink: 0;
}
.cove-avatar img { width: 100%; height: 100%; object-fit: cover; }

/* ---- Logo ---- */
.cove-logo { display: inline-flex; align-items: center; gap: 0.5rem; text-decoration: none; color: var(--cove-brand); }
.cove-logo-word { font-size: 1.15rem; font-weight: 800; letter-spacing: -0.02em; }
.cove-logo-tagline { display: block; font-size: 0.72rem; font-weight: 500; color: var(--cove-muted); margin-top: -2px; }

/* ---- Layout ---- */
.cove-main { flex: 1; padding: 2.5rem 1.5rem 4rem; }
.cove-container { max-width: 760px; margin: 0 auto; }
.cove-container-wide { max-width: 1040px; margin: 0 auto; }

/* ---- Cards / surfaces ---- */
.cove-card {
  background: var(--cove-surface);
  border: 1px solid var(--cove-border);
  border-radius: var(--cove-radius-lg);
  box-shadow: var(--cove-shadow);
  padding: 1.75rem;
}
.cove-panel { background: var(--cove-panel); border-radius: var(--cove-radius); padding: 1.25rem; }

/* ---- Typography ---- */
.cove-app h1 { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 0.5rem; }
.cove-app h2 { font-size: 1.2rem; font-weight: 700; margin: 0 0 0.5rem; }
.cove-app p { margin: 0 0 0.75rem; color: var(--cove-ink); }
.cove-muted { color: var(--cove-muted); }
.cove-eyebrow { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--cove-primary); }

/* ---- Buttons ---- */
.cove-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.7rem 1.1rem;
  border-radius: var(--cove-radius-sm);
  border: 1px solid transparent;
  font-weight: 700;
  font-size: 0.92rem;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.08s ease, box-shadow 0.08s ease;
}
.cove-btn:active { transform: translateY(1px); }
.cove-btn:disabled { opacity: 0.55; cursor: default; transform: none; }
.cove-btn-primary { background: var(--cove-primary); color: #fff; }
.cove-btn-primary:hover:not(:disabled) { background: var(--cove-primary-hover); }
.cove-btn-accent { background: var(--cove-accent); color: #fff; }
.cove-btn-accent:hover:not(:disabled) { background: var(--cove-accent-hover); }
.cove-btn-ghost { background: transparent; color: var(--cove-primary); border-color: var(--cove-border); }
.cove-btn-ghost:hover:not(:disabled) { background: var(--cove-panel); }
.cove-btn-link { background: none; border: none; color: var(--cove-primary); font-weight: 600; padding: 0; cursor: pointer; text-decoration: underline; }
.cove-btn-block { width: 100%; }

/* ---- OAuth brand buttons ---- */
.cove-oauth-btn {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: var(--cove-radius-sm);
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  border: 1px solid var(--cove-border);
}
.cove-oauth-btn:disabled { opacity: 0.6; cursor: default; }
.cove-oauth-btn-google { background: #fff; color: #1f1f1f; }
.cove-oauth-btn-google:hover:not(:disabled) { background: #f7f7f7; }
.cove-oauth-btn-apple { background: #000; color: #fff; border-color: #000; }
.cove-oauth-btn-apple:hover:not(:disabled) { background: #1a1a1a; }
.cove-oauth-icon { flex-shrink: 0; }

/* ---- Forms ---- */
.cove-field { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.88rem; font-weight: 600; margin-bottom: 0.9rem; }
.cove-input {
  padding: 0.6rem 0.75rem;
  border-radius: var(--cove-radius-sm);
  border: 1px solid var(--cove-border);
  font-size: 0.95rem;
  font-family: inherit;
  background: var(--cove-surface);
  color: var(--cove-ink);
}
.cove-input:focus { outline: 2px solid var(--cove-primary); outline-offset: 1px; }

/* ---- Alerts ---- */
.cove-alert { border-radius: var(--cove-radius-sm); padding: 0.75rem 1rem; font-size: 0.88rem; margin: 0 0 1rem; }
.cove-alert-error { background: var(--cove-danger-bg); color: var(--cove-danger); }
.cove-alert-success { background: var(--cove-success-bg); color: var(--cove-success); }

/* ---- Landing ---- */
.cove-landing { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0.7rem; padding: 1.5rem 0 1rem; }
.cove-hero-badge { margin-bottom: 0.1rem; filter: drop-shadow(0 8px 20px rgba(11, 61, 58, 0.25)); }
.cove-landing h1 { font-size: clamp(1.6rem, 3.4vw, 2.3rem); max-width: 20ch; margin: 0; }
.cove-landing-sub { color: var(--cove-muted); max-width: 46ch; font-size: 0.98rem; margin: 0; }
.cove-value-props { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; width: 100%; max-width: 720px; margin: 1rem 0; text-align: left; }
.cove-value-prop { background: var(--cove-surface); border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 0.85rem 1rem; }
.cove-value-prop-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--cove-panel); color: var(--cove-primary); margin-bottom: 0.6rem; }
.cove-value-prop h3 { font-size: 0.95rem; margin: 0 0 0.25rem; }
.cove-value-prop p { font-size: 0.85rem; color: var(--cove-muted); margin: 0; }
.cove-signin-box { max-width: 320px; width: 100%; display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.5rem; }
.cove-disclaimer { font-size: 0.78rem; color: var(--cove-muted); max-width: 46ch; margin-top: 1.25rem; }
.cove-disclaimer a { color: var(--cove-primary); font-weight: 600; }

/* ---- Dashboard ---- */
.cove-greeting { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.cove-greeting .cove-avatar { width: 52px; height: 52px; font-size: 1.2rem; }
.cove-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.cove-stat { background: var(--cove-panel); border-radius: var(--cove-radius); padding: 1rem 1.1rem; }
.cove-stat-icon { display: inline-flex; color: var(--cove-primary); opacity: 0.85; margin-bottom: 0.35rem; }
.cove-stat-value { font-size: 1.6rem; font-weight: 800; color: var(--cove-brand); }
.cove-stat-label { font-size: 0.8rem; color: var(--cove-muted); font-weight: 600; }

/* ---- Shop ---- */
.cove-category { margin-bottom: 2rem; }
.cove-category-icon { display: inline-flex; color: var(--cove-primary); vertical-align: -6px; margin-right: 0.4rem; }
.cove-category h2 { display: flex; align-items: center; gap: 0.5rem; }
.cove-test-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0.9rem; }
.cove-test-card { border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 1rem; background: var(--cove-surface); display: flex; flex-direction: column; gap: 0.5rem; transition: border-color 0.1s ease; }
.cove-test-card.is-selected { border-color: var(--cove-primary); box-shadow: 0 0 0 2px rgba(18, 118, 110, 0.15); }
.cove-test-card-top { display: flex; justify-content: space-between; align-items: start; gap: 0.5rem; }
.cove-test-name { font-weight: 700; font-size: 0.98rem; }
.cove-test-price { font-weight: 700; color: var(--cove-brand); white-space: nowrap; }
.cove-test-desc { font-size: 0.85rem; color: var(--cove-muted); flex: 1; }
.cove-cart-bar {
  position: sticky;
  bottom: 1rem;
  margin-top: 2rem;
  background: var(--cove-brand);
  color: #fff;
  border-radius: var(--cove-radius-lg);
  padding: 1rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  box-shadow: var(--cove-shadow);
}
.cove-cart-bar .cove-btn-accent { margin-left: auto; }

/* ---- Orders / timeline ---- */
.cove-order-list { display: flex; flex-direction: column; gap: 1rem; }
.cove-order-card { border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 1.25rem; background: var(--cove-surface); }
.cove-order-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; gap: 1rem; }
.cove-badge { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.25rem 0.6rem; border-radius: 999px; }
.cove-badge-pending_payment { background: var(--cove-warn-bg); color: var(--cove-warn); }
.cove-badge-fulfilled { background: var(--cove-panel); color: var(--cove-primary); }
.cove-badge-results_ready { background: var(--cove-success-bg); color: var(--cove-success); }
.cove-timeline { display: flex; align-items: center; margin: 1rem 0; }
.cove-timeline-step { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; position: relative; }
.cove-timeline-dot { width: 22px; height: 22px; border-radius: 999px; background: var(--cove-border); color: transparent; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; z-index: 1; }
.cove-timeline-step.is-done .cove-timeline-dot { background: var(--cove-primary); color: #fff; }
.cove-timeline-step.is-current .cove-timeline-dot { background: var(--cove-accent); color: #fff; }
.cove-timeline-label { font-size: 0.72rem; font-weight: 600; color: var(--cove-muted); text-align: center; }
.cove-timeline-step.is-done .cove-timeline-label, .cove-timeline-step.is-current .cove-timeline-label { color: var(--cove-ink); }
.cove-timeline-step:not(:last-child)::after { content: ""; position: absolute; top: 11px; left: 50%; width: 100%; height: 2px; background: var(--cove-border); z-index: 0; }
.cove-timeline-step.is-done:not(:last-child)::after { background: var(--cove-primary); }
.cove-order-items { list-style: none; padding: 0; margin: 0 0 0.75rem; font-size: 0.88rem; color: var(--cove-muted); }
.cove-results-table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.9rem; }
.cove-results-table td, .cove-results-table th { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid var(--cove-border); }
.cove-fastforward { border: 1px dashed var(--cove-border); border-radius: var(--cove-radius-sm); padding: 0.75rem; margin-top: 0.75rem; font-size: 0.85rem; }
.cove-fastforward-label { font-weight: 700; color: var(--cove-muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; display: block; margin-bottom: 0.4rem; }

/* ---- Checkout ---- */
.cove-checkout-summary { list-style: none; padding: 0; margin: 0 0 1rem; }
.cove-checkout-summary li { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--cove-border); font-size: 0.92rem; }
.cove-checkout-total { display: flex; justify-content: space-between; font-weight: 800; font-size: 1.05rem; padding: 0.75rem 0 0; }

/* ---- Account ---- */
.cove-account-row { display: flex; align-items: center; gap: 1rem; padding: 0.9rem 0; border-bottom: 1px solid var(--cove-border); }
.cove-account-row:last-of-type { border-bottom: none; }
.cove-account-label { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cove-muted); width: 90px; flex-shrink: 0; }

/* ---- OAuth modal ---- */
/* Sized against the backdrop, not the viewport: embedded (the docs site mounts
   this app inside its own modal window, which is the containing block for
   position: fixed), the backdrop covers only the app, not the whole screen. */
.cove-modal-backdrop { position: fixed; inset: 0; background: rgba(11, 30, 28, 0.5); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
.cove-modal { background: var(--cove-surface); border-radius: var(--cove-radius-lg); box-shadow: 0 24px 60px -20px rgba(0,0,0,0.45); width: 100%; max-width: 480px; height: min(760px, 100%); display: flex; flex-direction: column; overflow: hidden; }
.cove-modal-header { display: flex; align-items: center; gap: 0.6rem; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--cove-border); background: var(--cove-panel); flex-shrink: 0; }
.cove-modal-header-text { font-size: 0.82rem; font-weight: 700; color: var(--cove-brand); flex: 1; }
.cove-modal-close { background: none; border: none; cursor: pointer; color: var(--cove-muted); font-size: 1.1rem; line-height: 1; padding: 0.25rem; }
.cove-modal-body { flex: 1; overflow: auto; position: relative; min-height: 0; }
.cove-modal-body iframe { width: 100%; height: 100%; border: none; display: block; }
.cove-modal-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--cove-muted); font-size: 0.9rem; }
.cove-modal-error { padding: 1.25rem; }

/* ---- Loading ---- */
.cove-loading { display: flex; align-items: center; justify-content: center; padding: 3rem; color: var(--cove-muted); }
.cove-empty { text-align: center; color: var(--cove-muted); padding: 2.5rem 1rem; }

@media (max-width: 640px) {
  .cove-nav { padding: 0.7rem 1rem; gap: 0.75rem; }
  .cove-nav-links { gap: 0; }
  .cove-main { padding: 1.5rem 1rem 3rem; }
  .cove-card { padding: 1.25rem; }
  .cove-modal-backdrop { padding: 0; }
  .cove-modal { max-width: none; height: 100%; border-radius: 0; }
}
`
