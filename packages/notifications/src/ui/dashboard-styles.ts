import { scopeCss } from "./scope-css.js"

/** The class on the dashboard root. Every rule below is scoped to it. */
export const DASHBOARD_ROOT_CLASS = "mb-dashboard"

const RAW = `
:root {
  --mbd-bar: #12151b; --mbd-line: #2a2f3a; --mbd-text: #e8eaf0; --mbd-muted: #9aa1b1;
  --mbd-accent: #0a84ff; --mbd-hover: rgba(255,255,255,.07); --mbd-panel: #0e1015; --mbd-ok: #30d158;
}
&[data-theme="light"] {
  --mbd-bar: #ffffff; --mbd-line: #e4e8ee; --mbd-text: #172033; --mbd-muted: #667085;
  --mbd-accent: #2563d8; --mbd-hover: rgba(16,24,40,.06); --mbd-panel: #f5f7fa; --mbd-ok: #1f9d55;
}
@media (prefers-color-scheme: light) {
  &[data-theme="auto"] {
    --mbd-bar: #ffffff; --mbd-line: #e4e8ee; --mbd-text: #172033; --mbd-muted: #667085;
    --mbd-accent: #2563d8; --mbd-hover: rgba(16,24,40,.06); --mbd-panel: #f5f7fa; --mbd-ok: #1f9d55;
  }
}
:root { display: flex; flex-direction: column; box-sizing: border-box; height: 100%; min-height: 0; overflow: hidden;
  background: var(--mbd-panel); color: var(--mbd-text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
.mbd-bar, .mbd-bar *, .mbd-panels, .mbd-panel { box-sizing: border-box; }
.mbd-bar { flex: none; display: flex; align-items: stretch; gap: 18px; height: 46px; padding: 0 16px;
  background: var(--mbd-bar); border-bottom: 1px solid var(--mbd-line); }
.mbd-brand { display: flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
.mbd-mark { width: 24px; height: 24px; border-radius: 7px; background: linear-gradient(135deg,#0a84ff,#5e5ce6); flex: none;
  display: grid; place-items: center; color: #fff; font-size: 13px; line-height: 1; }
.mbd-tabs { display: flex; align-items: stretch; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.mbd-tabs::-webkit-scrollbar { display: none; }
.mbd-tab { position: relative; display: inline-flex; align-items: center; gap: 7px; padding: 0 13px; margin: 0; border: 0;
  background: none; color: var(--mbd-muted); font: inherit; font-weight: 560; white-space: nowrap; cursor: pointer; border-radius: 0; }
.mbd-tab::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: -1px; height: 2px; border-radius: 2px 2px 0 0; background: transparent; }
.mbd-tab:hover { color: var(--mbd-text); background: var(--mbd-hover); }
.mbd-tab[aria-selected="true"] { color: var(--mbd-text); }
.mbd-tab[aria-selected="true"]::after { background: var(--mbd-accent); }
.mbd-tab:focus-visible { outline: 2px solid var(--mbd-accent); outline-offset: -3px; border-radius: 7px; }
.mbd-badge { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: var(--mbd-accent); color: #fff;
  font-size: 11px; font-weight: 650; line-height: 18px; text-align: center; }
.mbd-badge[hidden] { display: none; }
.mbd-aside { display: flex; align-items: center; gap: 12px; margin-left: auto; min-width: 0; color: var(--mbd-muted); font-size: 12.5px; white-space: nowrap; }
.mbd-aside:empty { display: none; }
.mbd-aside a { color: var(--mbd-accent); text-decoration: none; font-weight: 560; }
.mbd-aside a:hover { text-decoration: underline; }
.mbd-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--mbd-line); border-radius: 999px; }
.mbd-pill b { color: var(--mbd-text); font-weight: 600; }
.mbd-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mbd-ok); }
.mbd-panels { flex: 1; min-height: 0; position: relative; }
.mbd-panel { height: 100%; overflow: auto; }
.mbd-panel[hidden] { display: none; }
.mbd-fill { height: 100%; }
.mbd-status { padding: 48px; color: var(--mbd-muted); }
.mbd-status[data-kind="error"] { color: #ff6b61; }
@media (max-width: 640px) {
  .mbd-bar { gap: 8px; height: 42px; padding: 0 8px; }
  .mbd-brand span { display: none; }
  .mbd-tabs { flex: 1; }
  .mbd-tab { flex: 1 0 auto; justify-content: center; padding: 0 10px; font-size: 13px; }
  .mbd-aside .mbd-pill { display: none; }
}
`

/** The dashboard shell's stylesheet: the tab bar and its panels, nothing inside them. */
export const DASHBOARD_STYLES = scopeCss(RAW, `.${DASHBOARD_ROOT_CLASS}`)

/** For a page that is only the dashboard: the document becomes one full-height, non-scrolling frame. */
export const DASHBOARD_PAGE_STYLES =
  "html.mbd-page, html.mbd-page body, html.mbd-page #app { height: 100%; min-height: 0; overflow: hidden; }"
