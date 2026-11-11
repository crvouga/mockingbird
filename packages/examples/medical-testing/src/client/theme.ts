/**
 * Plain CSS for the example app. Inlined by both run modes: the standalone
 * dev server embeds it in its HTML shell, and `src/browser.ts` injects it
 * as a `<style>` element scoped under `.cove-app` when mounted on the docs
 * site, so it never leaks into the docs site's own `global.css`.
 *
 * System fonts only. A web-font request would be a real network call.
 */
import { scopeReset } from "@crvouga/mockingbird-ui"

export const STYLES = `
${scopeReset(".cove-app")}
.cove-app {
  --cove-ink: light-dark(#18181b, #f4f4f5);
  --cove-brand: light-dark(#18181b, #f4f4f5);
  --cove-primary: light-dark(#27272a, #e4e4e7);
  --cove-primary-hover: light-dark(#3f3f46, #f4f4f5);
  --cove-on-brand: light-dark(#fff, #18181b);
  --cove-accent: light-dark(#27272a, #e4e4e7);
  --cove-accent-hover: light-dark(#3f3f46, #f4f4f5);
  --cove-bg: light-dark(#fafafa, #111113);
  --cove-panel: light-dark(#f4f4f5, #242428);
  --cove-surface: light-dark(#ffffff, #19191c);
  --cove-border: light-dark(#dedee3, #36363c);
  --cove-muted: light-dark(#62626b, #a9a9b2);
  --cove-danger: light-dark(#a82d32, #ffaaaa);
  --cove-danger-bg: light-dark(#fef2f2, #2c1516);
  --cove-success: light-dark(#166534, #86efac);
  --cove-success-bg: light-dark(#f0fdf4, #14241b);
  --cove-warn: light-dark(#a16207, #fde68a);
  --cove-warn-bg: light-dark(#fefce8, #2a2410);
  --cove-radius-sm: 8px;
  --cove-radius: 10px;
  --cove-radius-lg: 10px;
  --cove-shadow: none;
  --cove-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  all: initial;
  color-scheme: light dark;
  display: flex;
  flex-direction: column;
  min-width: 0;
  container-type: inline-size;
  container-name: cove;
  font-family: var(--cove-font);
  color: var(--cove-ink);
  background: var(--cove-bg);
  height: 100%;
  overflow: hidden;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* :where() keeps these resets from outranking a class. A plain
   ".cove-app button" would beat .cove-btn-primary and leave dark type on the dark fill. */
.cove-app :where(a) { color: inherit; }
.cove-app :where(button) { font-family: inherit; color: inherit; cursor: pointer; }
.cove-app :focus-visible { outline: 2px solid var(--cove-primary); outline-offset: 2px; }

.cove-shell { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }

/* ---- Top nav ---- */
.cove-nav {
  display: flex;
  align-items: center;
  min-width: 0;
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
  max-width: 16rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0.25rem 0.75rem 0.25rem 0.25rem;
  appearance: none;
}
.cove-nav-user:hover { border-color: var(--cove-border); background: var(--cove-panel); }
.cove-nav-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--cove-muted);
}
.cove-avatar {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: var(--cove-primary);
  color: var(--cove-on-brand);
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
.cove-main { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 2.5rem 1.5rem 4rem; }
.cove-main.is-shop { overflow: hidden; display: flex; flex-direction: column; padding-bottom: 1.25rem; }
.cove-container { max-width: 760px; margin: 0 auto; }
.cove-container.is-shop {
  flex: 1;
  min-height: 0;
  width: min(760px, 100%);
  display: flex;
  flex-direction: column;
}
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
.cove-app :where(h1) { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 0.5rem; }
.cove-app :where(h2) { font-size: 1.2rem; font-weight: 700; margin: 0 0 0.5rem; }
.cove-app :where(p) { margin: 0 0 0.75rem; color: var(--cove-ink); }
.cove-muted { color: var(--cove-muted); }
.cove-lede { margin: 0 0 1.35rem; color: var(--cove-muted); max-width: 62ch; }
.cove-eyebrow { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--cove-primary); }
.cove-card-gap { margin-bottom: 1rem; }

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
.cove-btn-primary { background: var(--cove-primary); color: var(--cove-on-brand); }
.cove-btn-primary:hover:not(:disabled) { background: var(--cove-primary-hover); }
.cove-btn-accent { background: var(--cove-accent); color: var(--cove-on-brand); }
.cove-btn-accent:hover:not(:disabled) { background: var(--cove-accent-hover); }
.cove-btn-ghost { background: transparent; color: var(--cove-primary); border-color: var(--cove-border); }
.cove-btn-ghost:hover:not(:disabled) { background: var(--cove-panel); }
.cove-btn-link { background: none; border: none; color: var(--cove-primary); font-weight: 600; padding: 0; cursor: pointer; text-decoration: underline; }
.cove-btn-block { width: 100%; }

.cove-oauth-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: var(--cove-radius-sm);
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  border: 1px solid var(--cove-border);
  background: var(--cove-surface);
  color: var(--cove-ink);
}
.cove-oauth-btn:hover:not(:disabled) { background: var(--cove-panel); }
.cove-oauth-btn:disabled { opacity: 0.6; cursor: default; }

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
.cove-landing { display: flex; flex-direction: column; align-items: center; padding: 1.25rem 0 1rem; }
.cove-hero-badge { display: none; }
.cove-signin-card { width: min(100%, 380px); text-align: left; }
.cove-signin-card h1 { font-size: 1.55rem; margin: 0 0 0.35rem; }
.cove-landing-sub { color: var(--cove-muted); font-size: 0.95rem; margin: 0 0 1.1rem; }
.cove-value-props { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 0.75rem; width: 100%; max-width: 720px; margin: 1rem 0; text-align: left; }
.cove-value-prop { background: var(--cove-surface); border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 0.85rem 1rem; }
.cove-value-prop-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--cove-panel); color: var(--cove-primary); margin-bottom: 0.6rem; }
.cove-value-prop h3 { font-size: 0.95rem; margin: 0 0 0.25rem; }
.cove-value-prop p { font-size: 0.85rem; color: var(--cove-muted); margin: 0; }
.cove-signin-box { display: flex; flex-direction: column; gap: 0.6rem; }
.cove-disclaimer { font-size: 0.78rem; color: var(--cove-muted); max-width: 46ch; margin-top: 1.25rem; }
.cove-disclaimer a { color: var(--cove-primary); font-weight: 600; }

/* ---- Dashboard ---- */
.cove-greeting { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
.cove-greeting h1 { margin: 0; }
.cove-greeting .cove-lede { margin: 0.15rem 0 0; }
.cove-greeting .cove-avatar { width: 48px; height: 48px; font-size: 1.05rem; }
.cove-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 1rem; margin: 1.5rem 0; }
.cove-stat { background: var(--cove-panel); border-radius: var(--cove-radius); padding: 1rem 1.1rem; }
.cove-stat-icon { display: inline-flex; color: var(--cove-primary); opacity: 0.85; margin-bottom: 0.35rem; }
.cove-stat-value { font-size: 1.6rem; font-weight: 800; color: var(--cove-brand); }
.cove-stat-label { font-size: 0.8rem; color: var(--cove-muted); font-weight: 600; }

/* ---- Shop ---- */
.cove-shop { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cove-shop-body { flex: 1; min-height: 0; overflow: auto; padding-bottom: 0.25rem; }
.cove-category { margin-bottom: 1.75rem; }
.cove-category-icon { display: inline-flex; color: var(--cove-muted); }
.cove-category h2 { display: flex; align-items: center; gap: 0.45rem; font-size: 1.02rem; margin: 0 0 0.7rem; }
.cove-test-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 0.75rem; align-items: stretch; }
.cove-test-card {
  appearance: none;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0.95rem 1rem 0.85rem;
  border: 1px solid var(--cove-border);
  border-radius: 12px;
  background: var(--cove-surface);
  color: inherit;
  font: inherit;
  text-align: left;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  cursor: pointer;
}
.cove-test-card:hover { border-color: light-dark(#c4c4cc, #52525b); }
.cove-test-card.is-selected { border-color: var(--cove-primary); background: light-dark(#fafafa, #1c1c1f); }
.cove-test-card.is-selected:hover { border-color: var(--cove-primary); }
.cove-test-name { font-weight: 680; font-size: 0.98rem; letter-spacing: -0.015em; line-height: 1.3; text-wrap: balance; }
.cove-test-price { font-weight: 650; font-size: 0.92rem; font-variant-numeric: tabular-nums; color: var(--cove-ink); }
.cove-test-desc { flex: 1 1 auto; margin-top: 0.35rem; font-size: 0.84rem; font-weight: 450; line-height: 1.45; color: var(--cove-muted); text-wrap: pretty; }
.cove-test-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  margin-top: 0.85rem;
  padding: 0 0.7rem;
  border-radius: 999px;
  border: 1px solid var(--cove-border);
  background: var(--cove-panel);
  color: var(--cove-ink);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.cove-test-card.is-selected .cove-test-add { background: var(--cove-primary); color: var(--cove-on-brand); border-color: transparent; }
.cove-cart-bar {
  flex: none;
  margin-top: 0.75rem;
  background: var(--cove-surface);
  color: var(--cove-ink);
  border: 1px solid var(--cove-border);
  border-radius: var(--cove-radius-lg);
  padding: 0.8rem 1rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
}
.cove-cart-bar .cove-btn-accent { margin-left: auto; }
.cove-cart-summary { font-weight: 650; font-variant-numeric: tabular-nums; }

/* ---- Orders / timeline ---- */
.cove-order-list { display: flex; flex-direction: column; gap: 1rem; }
.cove-order-card { border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 1.25rem; background: var(--cove-surface); }
.cove-order-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; margin-bottom: 0.65rem; gap: 0.4rem 1rem; min-width: 0; }
.cove-order-when { color: var(--cove-muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cove-badge { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.25rem 0.6rem; border-radius: 999px; }
.cove-badge-pending_payment { background: var(--cove-warn-bg); color: var(--cove-warn); }
.cove-badge-fulfilled { background: var(--cove-panel); color: var(--cove-primary); }
.cove-badge-results_ready { background: var(--cove-success-bg); color: var(--cove-success); }
.cove-timeline { display: flex; align-items: flex-start; margin: 0.85rem 0 0.35rem; }
.cove-timeline-step { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; position: relative; }
.cove-timeline-dot { width: 22px; height: 22px; border-radius: 999px; background: var(--cove-border); color: transparent; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; z-index: 1; }
.cove-timeline-step.is-done .cove-timeline-dot { background: var(--cove-primary); color: var(--cove-on-brand); }
.cove-timeline-step.is-current .cove-timeline-dot { background: var(--cove-accent); color: var(--cove-on-brand); }
.cove-timeline-label { font-size: 0.72rem; font-weight: 600; line-height: 1.25; color: var(--cove-muted); text-align: center; text-wrap: balance; }
.cove-timeline-step.is-done .cove-timeline-label, .cove-timeline-step.is-current .cove-timeline-label { color: var(--cove-ink); }
.cove-timeline-step:not(:last-child)::after { content: ""; position: absolute; top: 11px; left: 50%; width: 100%; height: 2px; background: var(--cove-border); z-index: 0; }
.cove-timeline-step.is-done:not(:last-child)::after { background: var(--cove-primary); }
.cove-order-items { list-style: none; padding: 0; margin: 0 0 0.35rem; font-size: 0.9rem; }
.cove-order-item { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: 0.35rem 0; }
.cove-order-item-price { font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
.cove-order-note { margin: 0.35rem 0 0; font-size: 0.82rem; color: var(--cove-muted); }
.cove-results-table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.9rem; }
.cove-results-table td, .cove-results-table th { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid var(--cove-border); overflow-wrap: anywhere; }
.cove-fastforward { border: 1px dashed var(--cove-border); border-radius: var(--cove-radius-sm); padding: 0.75rem; margin-top: 0.75rem; font-size: 0.85rem; }
.cove-fastforward-label { font-weight: 700; color: var(--cove-muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; display: block; margin-bottom: 0.4rem; }

/* ---- Checkout ---- */
.cove-checkout-summary { list-style: none; padding: 0; margin: 0 0 1rem; }
.cove-checkout-summary li { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--cove-border); font-size: 0.92rem; }
.cove-checkout-total { display: flex; justify-content: space-between; font-weight: 800; font-size: 1.05rem; padding: 0.75rem 0 0; }

/* ---- Account ---- */
.cove-account { max-width: 520px; }
.cove-account-row { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); align-items: center; gap: 0.75rem; padding: 0.85rem 0; border-bottom: 1px solid var(--cove-border); }
.cove-account-row:last-of-type { border-bottom: none; }
.cove-account-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cove-muted); }
.cove-avatar-md { width: 40px; height: 40px; }
.cove-account-signout { margin-top: 1.15rem; }

/* ---- OAuth modal ---- */
/* Sized against the backdrop, not the viewport: embedded (the docs site mounts
   this app inside its own modal window, which is the containing block for
   position: fixed), the backdrop covers only the app, not the whole screen. */
.cove-modal-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
.cove-modal { background: var(--cove-surface); border: 1px solid var(--cove-border); border-radius: var(--cove-radius); box-shadow: none; width: 100%; max-width: min(480px, 100%); min-width: 0; height: min(760px, 100%); display: flex; flex-direction: column; overflow: hidden; }
.cove-modal-header { display: flex; align-items: center; gap: 0.6rem; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--cove-border); background: var(--cove-panel); flex-shrink: 0; }
.cove-modal-header-text { font-size: 0.82rem; font-weight: 700; color: var(--cove-brand); flex: 1; }
.cove-modal-close { background: none; border: none; cursor: pointer; color: var(--cove-muted); font-size: 1.1rem; line-height: 1; padding: 0.25rem; }
.cove-modal-body { flex: 1; overflow: hidden; position: relative; min-height: 0; min-width: 0; }
.cove-modal-body .hosted-page { width: 100%; height: 100%; min-width: 0; display: block; overflow-x: clip; overflow-y: auto; }
.cove-modal-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--cove-muted); font-size: 0.9rem; }
.cove-modal-error { padding: 1.25rem; }

/* ---- Loading ---- */
.cove-loading { display: flex; align-items: center; justify-content: center; padding: 3rem; color: var(--cove-muted); }
.cove-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 0.85rem; color: var(--cove-muted); padding: 0.5rem 0 1rem; }
.cove-empty p { margin: 0; }

@container cove (max-width: 640px) {
  .cove-nav { flex-wrap: wrap; padding: 0.7rem 1rem; gap: 0.35rem 0.75rem; }
  .cove-nav-links { order: 3; flex: 1 0 100%; gap: 0; }
  .cove-spacer { display: none; }
  .cove-nav-user { margin-left: auto; }
  .cove-nav-name { display: none; }
  .cove-main { padding: 1.5rem 1rem 3rem; }
  .cove-card { padding: 1.25rem; }
  .cove-test-grid { grid-template-columns: 1fr; }
  .cove-account-row { grid-template-columns: 1fr; gap: 0.2rem; }
  .cove-order-when { white-space: normal; }
  .cove-modal-backdrop { padding: 0; }
  .cove-modal { max-width: none; height: 100%; border-radius: 0; }
}
/* Application workspace. Neutral surfaces, system type, and a single control language. */
.cove-app { font-size: 14px; }
.cove-app :where(h1, h2, h3, h4) { font-family: var(--cove-font); }
.cove-shell { flex-direction: row; }
.cove-sidebar { width: 220px; flex: none; display: flex; flex-direction: column; padding: 24px 14px 14px; border-right: 1px solid var(--cove-border); background: var(--cove-surface); min-height: 0; }
.cove-wordmark { display: inline-flex; align-items: center; min-height: 32px; gap: 10px; padding: 0 8px; font: inherit; font-size: 16px; font-weight: 650; line-height: 1; background: transparent; border: 0; white-space: nowrap; }
.cove-logo-box { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid var(--cove-border); border-radius: 7px; flex: none; line-height: 0; }
.cove-logo-box svg { display: block; width: 18px; height: 18px; }
.cove-workspace-label { padding: 32px 10px 10px; color: var(--cove-muted); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.cove-sidebar .cove-nav-links { flex-direction: column; align-items: stretch; gap: 4px; }
.cove-sidebar .cove-nav-link { display: flex; gap: 12px; align-items: center; border: 0; background: transparent; font-size: 13px; font-weight: 500; text-align: left; padding: 10px 12px; }
.cove-sidebar .cove-nav-link.is-active { background: var(--cove-panel); color: var(--cove-ink); font-weight: 650; }
.cove-nav-link > span { display: inline-flex; align-items: center; justify-content: center; width: 18px; min-height: 18px; font-size: 18px; line-height: 1; text-align: center; }
.cove-nav-link > span svg { display: block; width: 16px; height: 16px; }
.cove-sidebar-bottom { margin-top: auto; padding-top: 32px; }
.cove-sidebar-bottom > p { padding: 0 10px 16px; font-size: 12px; }
.cove-sidebar .cove-nav-user { width: 100%; border-radius: 8px; max-width: none; padding: 10px 8px; border-top: 1px solid var(--cove-border); }
.cove-nav-user > span:nth-child(2) { flex: 1; min-width: 0; text-align: left; }
.cove-nav-user strong { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.cove-nav-user small { display: block; color: var(--cove-muted); text-transform: capitalize; font-size: 11px; }
.cove-workspace { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.cove-topbar { flex: none; min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 32px; background: var(--cove-surface); border-bottom: 1px solid var(--cove-border); font-size: 13px; }
.cove-topbar-right { display: flex; align-items: center; gap: 12px; }
.cove-role { display: inline-flex; align-items: center; font-size: 11px; font-weight: 500; text-transform: capitalize; padding: 3px 8px; border: 1px solid var(--cove-border); border-radius: 5px; color: var(--cove-muted); background: var(--cove-surface); }
.cove-main { padding: 32px; }
.cove-container { width: 100%; max-width: 1120px; }
.cove-page { display: flex; flex-direction: column; gap: 24px; }
.cove-page > .cove-btn { align-self: flex-start; }
.cove-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.cove-page-head > div { min-width: 0; }
.cove-page-head > .cove-btn { flex: none; }
.cove-app :where(h1) { font-size: 28px; font-weight: 600; letter-spacing: -.025em; line-height: 1.25; text-wrap: balance; }
.cove-app :where(h2) { font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.cove-app :where(h3) { font-size: 14px; font-weight: 600; margin: 6px 0; }
.cove-eyebrow { font-size: 11px; letter-spacing: .07em; color: var(--cove-muted); font-weight: 500; margin-bottom: 10px; display: block; }
.cove-lede { font-size: 14px; margin: 10px 0 0; line-height: 1.6; }
.cove-text-sm { font-size: 12px; }
.cove-section-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.cove-section-head h2, .cove-section-head p { margin: 0; }
.cove-card { padding: 24px; border-radius: 8px; }
.cove-card-gap { margin-bottom: 20px; }
.cove-btn { padding: 9px 14px; min-height: 38px; font-size: 13px; font-weight: 550; border-radius: 6px; }
.cove-btn-sm { padding: 6px 10px; min-height: 32px; font-size: 12px; }
.cove-input { width: 100%; min-height: 38px; font-size: 13px; border-radius: 6px; }
.cove-input:read-only { background: var(--cove-panel); color: var(--cove-muted); }
.cove-field { font-size: 12px; font-weight: 500; gap: 6px; }
.cove-checkbox { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; margin: 20px 0; cursor: pointer; }
.cove-checkbox input { width: 16px; height: 16px; margin-top: 2px; flex: none; accent-color: var(--cove-primary); }
.cove-checkbox small { display: block; margin-top: 4px; color: var(--cove-muted); }
.cove-search { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 500; flex: 1; min-width: 160px; }
.cove-toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.cove-toolbar .cove-field { margin: 0; }
.cove-toolbar .cove-btn { align-self: flex-end; }
.cove-alert { margin: 0; }
.cove-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; margin-bottom: 20px; }
.cove-notice .cove-btn { align-self: center; flex: none; }
.cove-alert strong { display: block; margin-bottom: 6px; }
.cove-alert p { color: inherit; }
.cove-segment { display: flex; flex-wrap: wrap; align-self: flex-start; padding: 4px; gap: 4px; border: 1px solid var(--cove-border); border-radius: 7px; background: var(--cove-surface); }
.cove-segment button { background: transparent; border: 0; border-radius: 4px; padding: 7px 10px; font-size: 12px; }
.cove-segment button[aria-pressed="true"] { background: var(--cove-panel); font-weight: 600; }
.cove-stat-row { margin: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.cove-report-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 16px; }
.cove-stat { background: var(--cove-surface); border: 1px solid var(--cove-border); border-radius: 8px; padding: 20px; }
.cove-stat-value { font-size: 30px; font-weight: 550; line-height: 1.2; margin-top: 12px; }
.cove-stat-value.cove-text-sm { font-size: 18px; }
.cove-stat-label { font-size: 12px; font-weight: 450; }
.cove-dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr); gap: 24px; align-items: start; }
.cove-recent { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 0; text-align: left; border: 0; border-bottom: 1px solid var(--cove-border); background: transparent; }
.cove-recent:last-child { border-bottom: 0; }
.cove-recent:hover strong { text-decoration: underline; }
.cove-recent strong { font-size: 13px; font-weight: 550; }
.cove-recent p { margin: 5px 0 0; font-size: 12px; color: var(--cove-muted); }
.cove-how-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-top: 24px; }
.cove-shop-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; align-items: start; }
.cove-categories { margin: 16px 0 24px; }
.cove-test-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.cove-test-card { border-radius: 8px; padding: 20px; gap: 10px; cursor: default; }
.cove-test-card h2 { margin: 0; font-size: 16px; }
.cove-test-card .cove-eyebrow { margin: 0; }
.cove-test-desc { margin: 0; font-size: 13px; }
.cove-test-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.cove-test-meta span { font-size: 10px; color: var(--cove-muted); border: 1px solid var(--cove-border); border-radius: 4px; padding: 3px 6px; }
.cove-test-card details { width: 100%; border-top: 1px solid var(--cove-border); padding-top: 12px; font-size: 12px; }
.cove-test-card summary { cursor: pointer; color: var(--cove-muted); }
.cove-test-card details p { margin-top: 10px; }
.cove-summary-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 0; }
.cove-cart { position: sticky; top: 0; padding: 20px; }
.cove-cart-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--cove-border); padding: 14px 0; }
.cove-cart-item strong { font-size: 12px; }
.cove-cart-item p { margin: 6px 0 0; }
.cove-cart .cove-btn-block { margin-bottom: 12px; }
.cove-cart-placeholder { display: grid; place-items: center; min-height: 90px; border: 1px dashed var(--cove-border); border-radius: 6px; margin-top: 24px; font-size: 24px; color: var(--cove-muted); }
.cove-order-button { width: 100%; text-align: left; font: inherit; cursor: pointer; }
.cove-order-button:hover { border-color: var(--cove-muted); }
.cove-order-button h2 { margin: 16px 0 8px; }
.cove-order-button .cove-summary-row { padding: 0; }
.cove-badge { text-transform: none; font-weight: 500; letter-spacing: 0; font-size: 11px; padding: 4px 8px; border-radius: 5px; flex: none; }
.cove-badge-processing, .cove-badge-reviewed { background: var(--cove-panel); color: var(--cove-ink); }
.cove-badge-normal { background: var(--cove-success-bg); color: var(--cove-success); }
.cove-badge-high, .cove-badge-low { background: var(--cove-warn-bg); color: var(--cove-warn); }
.cove-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--cove-border); }
.cove-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 12px 0; margin-bottom: -1px; background: transparent; font: inherit; color: var(--cove-muted); font-size: 13px; }
.cove-tabs button[aria-selected="true"] { border-bottom-color: var(--cove-primary); color: var(--cove-ink); font-weight: 600; }
.cove-progress { display: flex; list-style: none; padding: 20px; border: 1px solid var(--cove-border); border-radius: 8px; background: var(--cove-surface); }
.cove-progress li { flex: 1; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--cove-muted); }
.cove-progress li span { width: 24px; height: 24px; border: 1px solid var(--cove-border); border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 10px; }
.cove-progress li.is-done { color: var(--cove-ink); }
.cove-progress li.is-done span { background: var(--cove-primary); color: var(--cove-on-brand); border-color: transparent; }
.cove-table-scroll { width: 100%; overflow: auto; }
.cove-results-table { margin: 0; min-width: 480px; font-size: 12px; }
.cove-results-table th { padding: 12px 10px; color: var(--cove-muted); font-size: 11px; font-weight: 500; white-space: nowrap; }
.cove-results-table td { padding: 16px 10px; font-variant-numeric: tabular-nums; }
.cove-results-table tr:last-child td { border: 0; }
.cove-results-table .cove-field { margin: 0; }
.cove-range { position: relative; height: 4px; margin: 8px 0 0; width: 100px; border-radius: 3px; background: var(--cove-border); }
.cove-range i { position: absolute; width: 7px; height: 7px; top: -2px; border-radius: 50%; background: var(--cove-success); }
.cove-range i.is-flagged { background: var(--cove-warn); }
.cove-event-list { list-style: none; padding: 0; margin-top: 24px; }
.cove-event-list li { display: flex; gap: 16px; position: relative; padding-bottom: 28px; }
.cove-event-list li:not(:last-child)::before { content: ""; position: absolute; left: 4px; top: 10px; bottom: 0; width: 1px; background: var(--cove-border); }
.cove-event-dot { width: 9px; height: 9px; margin-top: 6px; background: var(--cove-primary); border-radius: 50%; flex: none; }
.cove-event-list p { margin: 6px 0; font-size: 13px; }
.cove-event-list small { color: var(--cove-muted); font-size: 11px; }
.cove-review-note { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 16px; }
.cove-file-row { display: flex; align-items: center; gap: 16px; padding: 20px 0; border-bottom: 1px solid var(--cove-border); }
.cove-file-row:last-child { border: 0; }
.cove-file-row > div { flex: 1; }
.cove-file-row p { margin: 4px 0 0; }
.cove-file-icon { display: grid; place-items: center; width: 36px; height: 40px; border: 1px solid var(--cove-border); border-radius: 5px; }
.cove-permission-list { list-style: none; padding: 0; }
.cove-permission-list li { display: flex; gap: 10px; font-size: 12px; padding: 8px 0; }
.cove-permission-list span { color: var(--cove-success); }
.cove-confirm { background: var(--cove-panel); border: 1px solid var(--cove-border); padding: 20px; border-radius: 6px; margin-bottom: 20px; }
.cove-signin-layout { max-width: 1000px; margin: auto; min-height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 72px; align-items: center; padding: 24px; }
.cove-signin-intro > .cove-wordmark { padding: 0; margin-bottom: 60px; }
.cove-signin-intro h1 { font-size: clamp(30px, 4vw, 44px); font-weight: 550; letter-spacing: -.04em; }
.cove-signin-intro .cove-lede { margin: 20px 0 36px; }
.cove-signin-features > div { display: flex; gap: 20px; margin: 24px 0; }
.cove-signin-features > div > span { color: var(--cove-muted); font-size: 12px; padding-top: 3px; }
.cove-signin-features h2 { font-size: 14px; }
.cove-signin-features p { color: var(--cove-muted); font-size: 12px; margin: 0; }
.cove-signin-card { width: 100%; padding: 28px; }
.cove-signin-box { margin: 24px 0; }
.cove-demo-accounts { border-top: 1px solid var(--cove-border); padding-top: 20px; }
.cove-demo-account { display: block; width: 100%; margin-top: 8px; padding: 10px 12px; text-align: left; background: transparent; border: 1px solid var(--cove-border); border-radius: 6px; }
.cove-demo-account:hover { background: var(--cove-panel); }
.cove-email-form { margin-top: 20px; }
.cove-email-form .cove-btn { margin-bottom: 10px; }
.cove-email-form p { margin: 0; }
.cove-divider { display: flex; align-items: center; gap: 12px; margin: 20px 0 0; font-size: 11px; color: var(--cove-muted); }
.cove-divider::before, .cove-divider::after { content: ""; flex: 1; border-top: 1px solid var(--cove-border); }
.cove-signin-box { margin: 16px 0 24px; }
.cove-code-input { font-size: 20px; letter-spacing: .3em; font-variant-numeric: tabular-nums; text-align: center; min-height: 46px; }
.cove-code-input::placeholder { color: var(--cove-border); }
.cove-code-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; margin: 14px 0 4px; font-size: 12px; }
.cove-code-actions .cove-btn-link { font-size: 12px; font-weight: 500; }
.cove-btn-link:disabled { color: var(--cove-muted); text-decoration: none; }
.cove-inbox-hint { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0; padding: 12px 14px; border: 1px solid var(--cove-border); border-left: 3px solid var(--cove-primary); border-radius: 6px; background: var(--cove-panel); font-size: 12px; }
.cove-inbox-hint p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.cove-inbox-hint .cove-btn { flex: none; background: var(--cove-surface); }
.cove-signin-card .cove-inbox-hint { flex-direction: column; align-items: stretch; }
.cove-notice { flex-wrap: wrap; }
.cove-notice-actions { display: flex; gap: 8px; flex: none; margin-left: auto; }
.cove-stack { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.cove-card > h2 + .cove-text-sm { margin-top: 4px; }
.cove-pref-list { margin: 12px 0; border-top: 1px solid var(--cove-border); }
.cove-pref { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--cove-border); font-size: 13px; cursor: pointer; }
.cove-pref strong { font-weight: 550; }
.cove-pref small { display: block; margin-top: 2px; font-size: 11px; color: var(--cove-muted); }
.cove-switch { appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 36px; height: 20px; margin: 0; border-radius: 999px; background: var(--cove-border); cursor: pointer; transition: background .15s; }
.cove-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--cove-surface); transition: transform .15s; }
.cove-switch:checked { background: var(--cove-success); }
.cove-switch:checked::after { transform: translateX(16px); }
.cove-switch:disabled { opacity: .6; cursor: default; }
.cove-phone-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.cove-phone-row > div { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 14px; }
.cove-phone-row small { flex-basis: 100%; font-size: 11px; }
.cove-phone-actions { display: flex; gap: 8px; }
.cove-choice { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 0 0 16px; padding: 0; border: 0; font-size: 13px; }
.cove-choice legend { padding: 0; margin-bottom: 8px; font-size: 12px; font-weight: 500; }
.cove-choice label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.cove-choice input { margin: 0; accent-color: var(--cove-primary); }
.cove-form-actions, .cove-test-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.cove-test-buttons { margin: 14px 0 0; }
.cove-test-buttons + .cove-alert { margin-top: 14px; }
.cove-badge-shipped { background: var(--cove-panel); color: var(--cove-ink); }
.cove-demo-account > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
.cove-demo-account small { display: block; font-size: 11px; color: var(--cove-muted); margin-top: 5px; }
.cove-disclaimer { font-size: 11px; line-height: 1.6; }
.cove-footer { flex: none; text-align: center; border-top: 1px solid var(--cove-border); padding: 10px 16px; font-size: 10px; color: var(--cove-muted); background: var(--cove-surface); }
.cove-empty { padding: 40px 24px; align-items: center; text-align: center; }
.cove-empty h2 { margin: 0; }
.cove-empty p { color: var(--cove-muted); font-size: 13px; max-width: 44ch; }
.cove-empty-icon { font-size: 24px; margin-bottom: 4px; }
.cove-loading { gap: 12px; min-height: 180px; font-size: 13px; }
.cove-spinner { width: 16px; height: 16px; border: 2px solid var(--cove-border); border-top-color: var(--cove-primary); border-radius: 50%; animation: cove-spin 1s linear infinite; }
@keyframes cove-spin { to { transform: rotate(360deg); } }
.cove-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.cove-app :where(button:disabled) { cursor: not-allowed; opacity: .55; }
@container cove (max-width: 1100px) {
  .cove-sidebar { width: 190px; }
  .cove-shop-layout { grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; }
  .cove-test-grid { grid-template-columns: 1fr; }
  .cove-main { padding: 24px; }
  .cove-signin-layout { gap: 36px; }
}
@container cove (max-width: 850px) {
  .cove-shell { flex-direction: column; }
  .cove-sidebar { width: 100%; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--cove-border); }
  .cove-sidebar .cove-wordmark { margin-bottom: 12px; }
  .cove-workspace-label, .cove-sidebar-bottom { display: none; }
  .cove-sidebar .cove-nav-links { flex-direction: row; overflow-x: auto; flex-wrap: nowrap; }
  .cove-sidebar .cove-nav-link { white-space: nowrap; padding: 8px 10px; font-size: 12px; flex: none; }
  .cove-topbar { min-height: 48px; padding: 8px 20px; }
  .cove-dashboard-grid { grid-template-columns: 1fr; }
  .cove-signin-layout { grid-template-columns: 1fr; max-width: 500px; padding: 0; }
  .cove-signin-intro > .cove-wordmark { margin-bottom: 30px; }
  .cove-signin-features { display: none; }
  .cove-signin-intro .cove-lede { margin-bottom: 0; }
}
@container cove (max-width: 560px) {
  .cove-main { padding: 20px 16px; }
  .cove-card { padding: 18px; }
  .cove-page-head { flex-direction: column; gap: 16px; }
  .cove-shop-layout { grid-template-columns: 1fr; }
  .cove-cart { position: static; }
  .cove-stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .cove-stat { padding: 16px; }
  .cove-how-grid { grid-template-columns: 1fr; gap: 16px; }
  .cove-tabs { gap: 16px; }
  .cove-tabs button { font-size: 12px; }
  .cove-progress { padding: 14px; }
  .cove-progress li { flex-direction: column; align-items: center; text-align: center; font-size: 10px; }
  .cove-inbox-hint { flex-direction: column; align-items: stretch; }
  .cove-section-head { flex-wrap: wrap; }
  .cove-file-row { gap: 10px; flex-wrap: wrap; }
  .cove-file-icon { display: none; }
  .cove-footer { font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) { .cove-spinner { animation: none; } .cove-btn, .cove-switch, .cove-switch::after { transition: none; } }

`
