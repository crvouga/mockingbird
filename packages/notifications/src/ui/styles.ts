import { scopeCss } from "./scope-css.js"

/** The class on the UI root. Every rule below is scoped to it. */
export const ROOT_CLASS = "mb-notifications"

/** Harness chrome plus the three device skins. Device skins use their platform's own type and color. */
const RAW = `
:root {
  --bg: #0e1015; --panel: #161920; --panel-2: #1d212a; --line: #2a2f3a; --text: #e8eaf0;
  --muted: #9aa1b1; --accent: #0a84ff; --ok: #30d158; --bad: #ff453a; --warn: #ffd60a;
  --ios: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --android: "Google Sans Text", "Google Sans", Roboto, "Segoe UI", system-ui, sans-serif;
  --mail: "Google Sans", Roboto, RobotoDraft, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
:root { display: block; position: relative; box-sizing: border-box; min-height: 100%; background: var(--bg); color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
*, *::before, *::after { box-sizing: border-box; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }
&[data-motion="reduce"] *, &[data-motion="reduce"] *::before, &[data-motion="reduce"] *::after { animation: none !important; transition: none !important; }
&.embedded { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
&.embedded .mbn-scroll { flex: 1; min-height: 0; overflow: auto; }
&.embedded .inspector { position: absolute; }
[data-gesture]:focus-visible, [role="button"]:focus-visible, .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ── Harness chrome ─────────────────────────────────────────── */
.topbar { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  padding: 10px 18px; background: rgba(14,16,21,.86); backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; letter-spacing: -.01em; margin-right: 6px; }
.brand-mark { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg,#0a84ff,#5e5ce6); display: grid; place-items: center; }
.brand small { color: var(--muted); font-weight: 500; }
.field { display: flex; align-items: center; gap: 6px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; height: 32px; }
.field label { color: var(--muted); font-size: 12px; }
.field select, .field input { background: transparent; border: 0; outline: 0; height: 30px; min-width: 0; }
.field select option { background: var(--panel-2); }
.field.search { flex: 1 1 220px; max-width: 360px; }
.field.search input { width: 100%; }
.tabs { display: flex; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
.tabs button { background: none; border: 0; padding: 5px 12px; border-radius: 6px; color: var(--muted); font-weight: 550; }
.tabs button[aria-pressed="true"] { background: #2c3240; color: var(--text); }
.toggle { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; user-select: none; }
.toggle input { accent-color: var(--accent); }
.sources { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); font-size: 12px; color: var(--muted); white-space: nowrap; }
.pill b { color: var(--text); font-weight: 600; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(48,209,88,.15); }
.dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(255,69,58,.15); }
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.notice { margin: 14px 18px 0; padding: 10px 14px; border: 1px solid #5a2b2b; background: #2a1517; color: #ffb4ab; border-radius: 10px; font-size: 13px; }

.devices { display: flex; flex-wrap: wrap; gap: 28px; padding: 22px 18px 40px; align-items: flex-start; justify-content: center; }
.devices.solo .device-col.wide { max-width: 1280px; }
.device-col { display: flex; flex-direction: column; gap: 12px; align-items: center; width: 362px; flex: none; }
.device-col.wide { flex: 1 1 720px; width: auto; min-width: 0; max-width: 1180px; align-items: stretch; }
.device-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; justify-content: space-between; min-height: 32px; }
.device-head .controls { display: flex; gap: 6px; align-items: center; min-width: 0; }
.device-head h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 650; display: flex; align-items: center; gap: 8px; }
.device-head h2 .count { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11px; letter-spacing: 0; line-height: 18px; }
.device-head .field { height: 30px; max-width: 250px; min-width: 0; }
.device-head .field select { max-width: 190px; text-overflow: ellipsis; }
.seg { display: flex; background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 2px; }
.seg button { border: 0; background: none; color: var(--muted); padding: 2px 9px; border-radius: 5px; font-size: 12px; }
.seg button[aria-pressed="true"] { background: #2c3240; color: var(--text); }

/* ── Phone hardware ─────────────────────────────────────────── */
.iphone { position: relative; width: 362px; height: 760px; border-radius: 58px; padding: 12px; background: #0b0b0c;
  box-shadow: 0 0 0 2px #3a3a3c, 0 0 0 6px #1c1c1e, 0 0 0 7px #4a4a4e, 0 40px 80px rgba(0,0,0,.55); }
.iphone::before, .iphone::after { content: ""; position: absolute; left: -9px; width: 4px; border-radius: 2px; background: #2c2c2e; }
.iphone::before { top: 150px; height: 60px; }
.iphone::after { top: 225px; height: 60px; }
.iphone .screen { position: relative; width: 100%; height: 100%; border-radius: 47px; overflow: hidden; background: #fff; font-family: var(--ios); color: #000; -webkit-font-smoothing: antialiased; }
.island { position: absolute; z-index: 30; top: 11px; left: 50%; transform: translateX(-50%); width: 112px; height: 33px; border-radius: 20px; background: #000; }
.statusbar { position: absolute; z-index: 25; top: 0; left: 0; right: 0; height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 6px 32px 0 40px; font: 600 16px/1 var(--ios); letter-spacing: -.01em; }
.statusbar .icons { display: flex; gap: 6px; align-items: center; }
.statusbar.light { color: #fff; }
.home-indicator { position: absolute; z-index: 30; bottom: 8px; left: 50%; transform: translateX(-50%); width: 134px; height: 5px; border-radius: 3px; background: #000; }
.home-indicator.light { background: rgba(255,255,255,.9); }

.pixel { position: relative; width: 352px; height: 760px; border-radius: 44px; padding: 10px; background: #111;
  box-shadow: 0 0 0 2px #2b2b2f, 0 0 0 5px #3c3c41, 0 40px 80px rgba(0,0,0,.55); }
.pixel::after { content: ""; position: absolute; right: -7px; top: 170px; width: 4px; height: 90px; border-radius: 2px; background: #2c2c2e; }
.pixel .screen { position: relative; width: 100%; height: 100%; border-radius: 35px; overflow: hidden; font-family: var(--android); }
.punch { position: absolute; z-index: 30; top: 12px; left: 50%; width: 13px; height: 13px; margin-left: -6px; border-radius: 50%; background: #050505; box-shadow: inset 0 0 0 2px #1a1a1a; }

/* ── Messages (iOS) ─────────────────────────────────────────── */
.msgs { position: absolute; inset: 0; display: flex; flex-direction: column; background: #fff; }
.msgs-nav { padding: 54px 16px 0; }
.msgs-nav .row { display: flex; justify-content: space-between; align-items: center; height: 44px; color: #007aff; font-size: 17px; }
.msgs-nav h1 { margin: 2px 0 8px; font: 700 34px/41px var(--ios); letter-spacing: .01em; }
.ios-search { display: flex; align-items: center; gap: 6px; height: 36px; border-radius: 10px; background: rgba(118,118,128,.12); color: rgba(60,60,67,.6); padding: 0 8px; font-size: 17px; margin-bottom: 8px; }
.ios-search span { flex: 1; }
.threads { flex: 1; overflow-y: auto; }
.thread { position: relative; display: flex; gap: 12px; padding: 10px 16px 0 26px; cursor: pointer; }
.thread:active { background: #e5e5ea; }
.thread .unread { position: absolute; left: 8px; top: 30px; width: 10px; height: 10px; border-radius: 50%; background: #007aff; }
.avatar { flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 600 18px var(--ios); background: linear-gradient(180deg,#a5abb8,#858994); }
.thread .text { flex: 1; min-width: 0; border-bottom: .5px solid #c6c6c8; padding-bottom: 10px; }
.thread .top { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.thread .name { font: 600 17px/22px var(--ios); letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread .when { flex: none; color: rgba(60,60,67,.6); font-size: 15px; display: flex; align-items: center; gap: 6px; }
.thread .preview { color: rgba(60,60,67,.6); font-size: 15px; line-height: 20px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; letter-spacing: -.01em; }
.empty-ios { flex: 1; display: grid; place-items: center; color: rgba(60,60,67,.6); font-size: 17px; text-align: center; padding: 40px; }

.convo { position: absolute; inset: 0; display: flex; flex-direction: column; background: #fff; }
.convo-nav { position: relative; z-index: 5; padding-top: 50px; background: rgba(249,249,249,.94); backdrop-filter: blur(20px); border-bottom: .5px solid rgba(0,0,0,.18); }
.convo-nav .bar { position: relative; height: 96px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
.convo-nav .back { position: absolute; left: 8px; top: 8px; display: flex; align-items: center; color: #007aff; font-size: 17px; background: none; border: 0; padding: 4px; }
.convo-nav .back .badge { background: #007aff; color: #fff; border-radius: 10px; font-size: 13px; min-width: 20px; padding: 0 6px; line-height: 20px; margin-left: 2px; }
.convo-nav .avatar { width: 54px; height: 54px; font-size: 22px; }
.convo-nav .who { font-size: 12px; display: flex; align-items: center; gap: 2px; }
.convo-body { flex: 1; overflow-y: auto; padding: 8px 0 12px; }
.stamp { text-align: center; color: rgba(60,60,67,.6); font-size: 12px; margin: 14px 0 6px; }
.stamp b { font-weight: 600; }
.bubble-row { display: flex; padding: 0 14px; margin-top: 2px; }
.bubble-row.gap { margin-top: 10px; }
.bubble { position: relative; max-width: 74%; padding: 7px 12px 8px; border-radius: 18px; background: #e9e9eb; color: #000; font-size: 17px; line-height: 22px; letter-spacing: -.02em; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble.tail::before { content: ""; position: absolute; bottom: 0; left: -7px; width: 20px; height: 20px; background: #e9e9eb; border-bottom-right-radius: 15px; }
.bubble.tail::after { content: ""; position: absolute; bottom: 0; left: -10px; width: 10px; height: 20px; background: #fff; border-bottom-right-radius: 10px; }
.bubble a, .bubble .code { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.bubble .media { display: block; max-width: 100%; border-radius: 12px; margin: 2px 0 4px; }
.bubble.arrive { animation: mbn-pop .35s cubic-bezier(.2,.9,.3,1.3); }
.delivered-note { padding: 2px 16px 0 26px; color: rgba(60,60,67,.6); font-size: 11px; }
.convo-input { display: flex; align-items: flex-end; gap: 8px; padding: 6px 10px 32px; background: #fff; }
.convo-input .plus { width: 34px; height: 34px; border-radius: 50%; background: #e9e9eb; display: grid; place-items: center; flex: none; }
.convo-input .field-ios { flex: 1; height: 36px; border: 1px solid #c6c6c8; border-radius: 18px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px 0 14px; color: #c4c4c6; font-size: 17px; }
.qt { margin: 0 10px 6px; padding: 8px 12px; border-radius: 10px; background: #d1d3d9; text-align: center; font-size: 15px; color: #000; }
.qt small { display: block; font-size: 12px; color: #3c3c43; }

/* ── Lock screen (iOS) ──────────────────────────────────────── */
.lock { position: absolute; inset: 0; color: #fff; overflow: hidden;
  background: radial-gradient(120% 70% at 20% 10%, #6f86ff 0%, transparent 55%), radial-gradient(90% 60% at 90% 30%, #ff7eb3 0%, transparent 60%), radial-gradient(120% 80% at 50% 100%, #1d1b4a 0%, transparent 70%), linear-gradient(180deg,#3a3f9f,#141433); }
.lock .padlock { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); opacity: .95; }
.lock .date { position: absolute; top: 84px; width: 100%; text-align: center; font: 600 19px var(--ios); letter-spacing: .01em; opacity: .92; }
.lock .clock { position: absolute; top: 102px; width: 100%; text-align: center; font: 700 92px/1 "SF Pro Rounded", var(--ios); letter-spacing: -.02em; color: rgba(255,255,255,.93); }
.lock-stack { position: absolute; left: 10px; right: 10px; top: 236px; bottom: 112px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; scrollbar-width: none; }
.lock-stack::-webkit-scrollbar { display: none; }
.lock-stack .center-label { text-align: center; font: 600 15px var(--ios); opacity: .85; padding: 4px 0; }
.ios-note { position: relative; display: flex; gap: 10px; padding: 11px 12px 12px 11px; border-radius: 22px; color: #000; background: rgba(246,246,246,.66); backdrop-filter: blur(28px) saturate(180%); -webkit-backdrop-filter: blur(28px) saturate(180%); cursor: pointer; box-shadow: 0 1px 0 rgba(255,255,255,.25) inset; }
.ios-note.arrive { animation: mbn-drop .45s cubic-bezier(.2,.9,.3,1.15); }
.ios-note .app-icon { flex: none; width: 38px; height: 38px; border-radius: 9px; display: grid; place-items: center; color: #fff; font: 700 18px var(--ios); box-shadow: 0 0 0 .5px rgba(0,0,0,.08); }
.ios-note .content { flex: 1; min-width: 0; }
.ios-note .line1 { display: flex; justify-content: space-between; gap: 8px; }
.ios-note .title { font: 600 15px/20px var(--ios); letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ios-note .time { flex: none; font-size: 13px; color: rgba(60,60,67,.62); }
.ios-note .body { font: 400 15px/20px var(--ios); letter-spacing: -.02em; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.ios-note .thumb { flex: none; width: 38px; height: 38px; border-radius: 7px; object-fit: cover; align-self: center; }
.ios-note.expanded .body { -webkit-line-clamp: unset; }
.ios-note .hero { width: 100%; border-radius: 12px; margin-top: 8px; display: block; }
.note-data { margin-top: 8px; font: 12px/1.45 var(--mono); background: rgba(255,255,255,.55); border-radius: 10px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; color: #1c1c1e; }
.note-meta { margin-top: 6px; font-size: 12px; color: rgba(60,60,67,.7); }
.ios-stack-more { position: relative; height: 18px; margin: -14px 14px 0; border-radius: 0 0 18px 18px; background: rgba(246,246,246,.42); backdrop-filter: blur(20px); }
.ios-stack-more + .ios-stack-more { margin: -10px 26px 0; background: rgba(246,246,246,.28); }
.lock-buttons { position: absolute; bottom: 46px; left: 46px; right: 46px; display: flex; justify-content: space-between; }
.lock-buttons span { width: 50px; height: 50px; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,.28); backdrop-filter: blur(20px); }
.lock-empty { text-align: center; font: 500 15px var(--ios); opacity: .7; margin-top: 30px; }

/* ── Notification shade (Android) ───────────────────────────── */
.shade { position: absolute; inset: 0; color: #e6e1e5; background: linear-gradient(180deg, rgba(20,18,24,.94), rgba(20,18,24,.98)), radial-gradient(100% 60% at 30% 0%, #4b3f72, #141218); overflow: hidden; }
.shade .sb { position: absolute; top: 0; left: 0; right: 0; height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 6px 24px 0; font: 500 14px var(--android); color: #e6e1e5; }
.shade .sb .icons { display: flex; gap: 5px; align-items: center; }
.shade .qs-head { position: absolute; top: 46px; left: 22px; right: 22px; display: flex; justify-content: space-between; align-items: center; font: 400 15px var(--android); color: #cac4d0; }
.qs { position: absolute; top: 80px; left: 14px; right: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.qs .tile { height: 60px; border-radius: 20px; background: #36343b; display: flex; align-items: center; gap: 10px; padding: 0 14px; font: 500 14px var(--android); color: #e6e1e5; min-width: 0; }
.qs .tile > div { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qs .tile svg { flex: none; }
.qs .tile.on { background: #d0bcff; color: #381e72; }
.qs .tile small { display: block; font-weight: 400; font-size: 12px; opacity: .8; }
.qs-bright { position: absolute; top: 216px; left: 14px; right: 14px; height: 44px; border-radius: 22px; background: #36343b; overflow: hidden; }
.qs-bright::before { content: ""; position: absolute; inset: 0 44% 0 0; background: #d0bcff; border-radius: 22px; }
.shade-list { position: absolute; top: 276px; left: 10px; right: 10px; bottom: 92px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; scrollbar-width: none; }
.shade-list::-webkit-scrollbar { display: none; }
.a-note { background: #2b2930; border-radius: 6px; padding: 14px 16px 14px 14px; cursor: pointer; display: flex; gap: 12px; }
.a-note:first-child { border-top-left-radius: 26px; border-top-right-radius: 26px; }
.a-note:last-child { border-bottom-left-radius: 26px; border-bottom-right-radius: 26px; }
.a-note.arrive { animation: mbn-headsup .5s cubic-bezier(.2,.9,.3,1.12); }
.a-note .a-icon { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 600 15px var(--android); }
.a-note .a-main { flex: 1; min-width: 0; }
.a-note .a-head { display: flex; align-items: center; gap: 6px; font: 400 12px var(--android); color: #cac4d0; }
.a-note .a-head .chev { margin-left: auto; width: 26px; height: 20px; border-radius: 10px; background: #49454f; display: grid; place-items: center; }
.a-note .a-title { font: 500 15px/20px var(--android); color: #e6e1e5; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.a-note .a-body { font: 400 14px/20px var(--android); color: #cac4d0; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.a-note.expanded .a-body { -webkit-line-clamp: unset; }
.a-note .large-icon { flex: none; width: 40px; height: 40px; border-radius: 8px; object-fit: cover; align-self: center; }
.a-note .big-picture { display: block; width: 100%; border-radius: 14px; margin-top: 10px; }
.a-note .note-data { background: #1d1b20; color: #e6e1e5; }
.a-note .note-meta { color: #938f99; }
.shade-actions { position: absolute; bottom: 44px; left: 14px; right: 14px; display: flex; justify-content: space-between; }
.shade-actions span { padding: 8px 16px; border-radius: 18px; background: #36343b; font: 500 14px var(--android); color: #e6e1e5; }
.shade-empty { text-align: center; color: #938f99; font: 400 14px var(--android); margin-top: 26px; }
.gesture { position: absolute; bottom: 12px; left: 50%; width: 110px; height: 4px; margin-left: -55px; border-radius: 2px; background: rgba(255,255,255,.75); }

/* ── Mail (web client) ──────────────────────────────────────── */
.window { position: relative; container-type: inline-size; border-radius: 12px; overflow: hidden; background: #f8fafd; box-shadow: 0 0 0 1px #2c313c, 0 30px 70px rgba(0,0,0,.5); height: 760px; display: flex; flex-direction: column; font-family: var(--mail); color: #1f1f1f; }
.chrome { flex: none; height: 38px; background: #dfe3e9; display: flex; align-items: center; gap: 12px; padding: 0 12px; }
.lights { display: flex; gap: 7px; }
.lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
.lights i:nth-child(1) { background: #ff5f57; } .lights i:nth-child(2) { background: #febc2e; } .lights i:nth-child(3) { background: #28c840; }
.omnibox { flex: 1; max-width: 560px; margin: 0 auto; height: 26px; border-radius: 13px; background: #fff; display: flex; align-items: center; gap: 8px; padding: 0 12px; color: #5f6368; font: 13px system-ui; }
.mail-top { flex: none; height: 64px; display: flex; align-items: center; gap: 8px; padding: 8px 16px 8px 12px; }
.icon-btn { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: #444746; border: 0; background: none; flex: none; }
.icon-btn:hover { background: rgba(68,71,70,.08); }
.mail-logo { display: flex; align-items: center; gap: 6px; width: 194px; font: 400 22px var(--mail); color: #444746; letter-spacing: -.01em; }
.mail-search { flex: 1; min-width: 0; max-width: 720px; height: 48px; border-radius: 24px; background: #e9eef6; display: flex; align-items: center; gap: 4px; padding: 0 4px; color: #444746; font-size: 16px; }
.mail-search .placeholder { flex: 1; padding-left: 4px; }
.mail-top .right { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.mail-avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 500 15px var(--mail); margin-left: 8px; }
.mail-body { flex: 1; min-height: 0; display: flex; }
.mail-nav { flex: none; width: 236px; padding: 8px 8px 0 0; overflow: hidden; }
.compose { display: inline-flex; align-items: center; gap: 12px; height: 56px; padding: 0 22px 0 16px; margin: 0 0 16px 8px; border-radius: 16px; background: #c2e7ff; color: #001d35; font: 500 14px var(--mail); border: 0; box-shadow: none; }
.nav-item { display: flex; align-items: center; gap: 18px; height: 32px; padding: 0 12px 0 26px; border-radius: 0 16px 16px 0; color: #202124; font: 400 14px var(--mail); }
.nav-item.active { background: #d3e3fd; font-weight: 700; color: #001d35; }
.nav-item .n { margin-left: auto; font-size: 12px; }
.mail-main { flex: 1; min-width: 0; margin: 0 16px 16px 0; background: #fff; border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
.mail-toolbar { flex: none; height: 48px; display: flex; align-items: center; gap: 4px; padding: 0 12px 0 14px; color: #444746; }
.mail-toolbar .range { margin-left: auto; font-size: 12px; color: #444746; }
.cat-tabs { flex: none; display: flex; border-bottom: 1px solid #f1f3f4; }
.cat-tabs div { flex: 0 1 250px; min-width: 0; height: 54px; display: flex; align-items: center; gap: 16px; padding: 0 16px; color: #444746; font: 500 14px var(--mail); position: relative; }
.cat-tabs div.on { color: #0b57d0; }
.cat-tabs div.on::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 3px; border-radius: 3px 3px 0 0; background: #0b57d0; }
.mail-list { flex: 1; overflow-y: auto; }
.mrow { display: flex; align-items: center; height: 40px; padding: 0 16px 0 12px; border-bottom: 1px solid #f1f3f4; cursor: pointer; font-size: 14px; color: #202124; background: #f2f6fc; }
.mrow.unread { background: #fff; font-weight: 700; }
.mrow:hover { box-shadow: inset 1px 0 0 #dadce0, inset -1px 0 0 #dadce0, 0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15); position: relative; z-index: 1; }
.mrow.arrive { animation: mbn-rowflash 1.6s ease-out; }
.mrow .chk, .mrow .star { flex: none; width: 20px; height: 20px; margin-right: 10px; color: #c4c7c5; display: grid; place-items: center; }
.mrow .from { flex: none; width: 168px; padding-right: 24px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrow .subj { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrow .snippet { color: #5f6368; font-weight: 400; }
.mrow .clip { color: #5f6368; margin-left: 8px; flex: none; }
.mrow .date { flex: none; width: 78px; text-align: right; font-size: 12px; }
.mrow .svc { flex: none; font: 500 10px var(--mail); color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 0 4px; margin-left: 8px; font-weight: 500; text-transform: uppercase; letter-spacing: .03em; }
.mail-empty { padding: 60px 20px; text-align: center; color: #5f6368; font: 400 14px var(--mail); }
.mail-empty b { display: block; font: 400 22px var(--mail); color: #1f1f1f; margin: 12px 0 4px; }
.reader { flex: 1; overflow-y: auto; padding: 0 0 24px; }
.reader .subject-row { display: flex; align-items: center; gap: 10px; padding: 18px 16px 8px 72px; }
.reader h1 { margin: 0; font: 400 22px/28px var(--mail); color: #1f1f1f; }
.label-chip { font: 400 12px var(--mail); background: #ddd; border-radius: 4px; padding: 0 6px; color: #444746; display: inline-flex; gap: 4px; align-items: center; }
.sender-row { display: flex; gap: 14px; padding: 12px 16px 0 16px; }
.sender-row .mail-avatar { width: 40px; height: 40px; font-size: 18px; margin: 0; }
.sender-row .who { flex: 1; min-width: 0; }
.sender-row .who b { font: 700 14px var(--mail); color: #1f1f1f; }
.sender-row .who .addr { font: 400 12px var(--mail); color: #5e5e5e; }
.sender-row .who .to { font: 400 12px var(--mail); color: #5e5e5e; display: flex; align-items: center; gap: 2px; margin-top: 2px; }
.sender-row .meta { display: flex; align-items: center; gap: 4px; color: #5e5e5e; font: 400 12px var(--mail); white-space: nowrap; }
.details { margin: 8px 16px 0 70px; padding: 10px 14px; border: 1px solid #dadce0; border-radius: 8px; font: 12px/1.6 var(--mail); color: #5e5e5e; display: grid; grid-template-columns: max-content 1fr; gap: 0 12px; }
.details span:nth-child(odd) { text-align: right; }
.details span:nth-child(even) { color: #1f1f1f; overflow-wrap: anywhere; }
.mail-frame { display: block; width: calc(100% - 86px); margin: 16px 16px 0 70px; border: 0; min-height: 120px; background: #fff; }
.mail-text { margin: 16px 16px 0 70px; white-space: pre-wrap; font: 400 14px/1.55 Arial, sans-serif; color: #222; overflow-wrap: anywhere; }
.mail-text a { color: #1155cc; }
.attachments { margin: 18px 16px 0 70px; border-top: 1px solid #e0e0e0; padding-top: 14px; }
.attachments h3 { margin: 0 0 10px; font: 500 14px var(--mail); color: #1f1f1f; }
.att-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.att { width: 180px; height: 104px; border: 1px solid #dadce0; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
.att .att-top { flex: 1; background: #f1f3f4; display: grid; place-items: center; color: #d93025; }
.att .att-name { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 10px; font: 500 12px var(--mail); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reply-row { display: flex; gap: 10px; margin: 24px 16px 0 70px; }
.reply-row span { display: inline-flex; align-items: center; gap: 8px; padding: 0 22px 0 16px; height: 36px; border: 1px solid #747775; border-radius: 18px; font: 500 14px var(--mail); color: #444746; }

/* ── Timeline + inspector ───────────────────────────────────── */
.timeline { padding: 18px; overflow-x: auto; }
.tl td.mono:first-child { white-space: nowrap; }
.tl { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.tl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; padding: 10px 12px; background: var(--panel-2); border-bottom: 1px solid var(--line); }
.tl td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
.tl tr:last-child td { border-bottom: 0; }
.tl tbody tr { cursor: pointer; }
.tl tbody tr:hover { background: #1b1f28; }
.tl .content { max-width: 520px; color: var(--muted); }
.tl .content b { color: var(--text); font-weight: 600; }
.tl .mono { font-family: var(--mono); font-size: 12px; }
.chan { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
.chan.sms { background: rgba(48,209,88,.14); color: #6ee38a; }
.chan.email { background: rgba(10,132,255,.16); color: #69b0ff; }
.chan.push { background: rgba(255,159,10,.15); color: #ffc15e; }
.svc-tag { font-size: 12px; color: var(--muted); }
.empty-tl { padding: 60px; text-align: center; color: var(--muted); }
.inspector { position: fixed; z-index: 40; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: -20px 0 50px rgba(0,0,0,.4); display: flex; flex-direction: column; }
.inspector header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.inspector header h3 { margin: 0; font-size: 15px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector .btn { background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; font-size: 13px; }
.inspector pre { margin: 0; flex: 1; overflow: auto; padding: 14px 16px; font: 12px/1.55 var(--mono); color: #cdd3df; white-space: pre-wrap; overflow-wrap: anywhere; }
.inspector .kv { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); font-size: 13px; }
.inspector .kv span:nth-child(odd) { color: var(--muted); }
.inspector .kv span:nth-child(even) { overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; }


/* ── Sound toggle ───────────────────────────────────────────── */
.icon-toggle { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--muted); font-size: 13px; }
.icon-toggle[aria-pressed="true"] { color: var(--text); border-color: #3d4a66; }

/* ── Swipe gestures ─────────────────────────────────────────── */
.swipe { position: relative; touch-action: pan-y; }
.swipe > .swipe-card { position: relative; z-index: 1; will-change: transform; }
.swipe.settling > .swipe-card, .settling.a-note { transition: transform .32s cubic-bezier(.2,.9,.25,1), opacity .32s ease; }
.swipe-actions { position: absolute; inset: 0; display: flex; justify-content: flex-end; align-items: stretch; visibility: hidden; }
.swipe.swiping > .swipe-actions, .swipe.open > .swipe-actions { visibility: visible; }
.collapsing { overflow: hidden; transition: height .26s ease, margin .26s ease, padding .26s ease, opacity .2s ease !important; }

/* iOS lock screen: Options / Clear behind a card */
.ios-swipe .swipe-actions { gap: 8px; }
.ios-swipe .swipe-actions button { width: 72px; border: 0; border-radius: 20px; background: rgba(246,246,246,.6); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); color: #000; font: 500 14px var(--ios); }
.push-group { display: flex; flex-direction: column; gap: 8px; }
.group-head { display: flex; align-items: center; gap: 8px; padding: 0 2px; animation: mbn-fadein .25s ease; }
.group-head h3 { flex: 1; margin: 0; font: 700 20px/1.2 var(--ios); color: #fff; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-head button { border: 0; border-radius: 15px; background: rgba(246,246,246,.6); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); color: #000; font: 500 13px var(--ios); padding: 6px 12px; }
.group-head button.x { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border-radius: 50%; }
.push-group[data-open="true"] .ios-swipe { animation: mbn-unstack .38s cubic-bezier(.2,.9,.3,1.1) backwards; }
.push-group[data-open="true"] .ios-swipe:nth-child(3) { animation-delay: .03s; } .push-group[data-open="true"] .ios-swipe:nth-child(4) { animation-delay: .06s; }
.stack-layers { cursor: pointer; border: 0; padding: 0; background: none; display: block; width: 100%; }
.stack-layers .ios-stack-more:first-child { margin-top: -14px; }
.lock.wake { animation: mbn-wake 1.1s ease-out; }
.ios-overlay { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 0 14px; background: rgba(255,255,255,.28); backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%); animation: mbn-fadein .2s ease; }
.ios-overlay.dark { background: rgba(0,0,0,.28); }
.ios-overlay .ios-note { animation: mbn-lift .3s cubic-bezier(.2,.9,.3,1.2); box-shadow: 0 20px 40px rgba(0,0,0,.25); }
.ios-menu { align-self: flex-start; width: 250px; border-radius: 14px; overflow: hidden; background: rgba(237,237,237,.86); backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px); box-shadow: 0 10px 40px rgba(0,0,0,.2); animation: mbn-lift .28s cubic-bezier(.2,.9,.3,1.2); }
.ios-menu button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 11px 16px; border: 0; border-bottom: .5px solid rgba(60,60,67,.29); background: none; color: #000; font: 400 17px var(--ios); letter-spacing: -.02em; text-align: left; }
.ios-menu button:last-child { border-bottom: 0; }
.ios-menu button:active { background: rgba(0,0,0,.08); }
.ios-overlay.dark .ios-menu { align-self: stretch; width: auto; }

/* Android shade */
.a-note { touch-action: pan-y; position: relative; }
.a-settings { margin-top: 8px; display: grid; gap: 8px; animation: mbn-fadein .2s ease; }
.a-settings .opt { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 16px; border: 1px solid #49454f; font: 500 14px var(--android); color: #e6e1e5; background: none; text-align: left; }
.a-settings .opt[aria-pressed="true"] { background: #4a4458; border-color: #d0bcff; }
.a-settings .opt small { display: block; font-weight: 400; color: #cac4d0; font-size: 12px; }
.a-settings .row { display: flex; justify-content: space-between; }
.a-settings .row button { border: 0; background: none; color: #d0bcff; font: 500 14px var(--android); padding: 6px 4px; }
.shade-actions button { padding: 8px 16px; border: 0; border-radius: 18px; background: #36343b; font: 500 14px var(--android); color: #e6e1e5; }

/* Messages: thread swipe actions, page transitions, bubble times, tapbacks */
.thread-swipe .swipe-actions { justify-content: space-between; }
.thread-swipe .swipe-actions .side { display: flex; }
.thread-swipe .swipe-actions button { width: 74px; border: 0; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: 400 13px var(--ios); }
.act-unread { background: #007aff; } .act-pin { background: #ffcc00; } .act-mute { background: #5856d6; } .act-delete { background: #ff3b30; }
.thread-swipe .thread { background: #fff; }
.thread .name-line { display: flex; align-items: center; gap: 4px; min-width: 0; }
.thread .flag { flex: none; color: rgba(60,60,67,.6); display: inline-flex; }
.msgs.enter { animation: mbn-back .38s cubic-bezier(.2,.9,.25,1); }
.convo.enter { animation: mbn-push .4s cubic-bezier(.2,.9,.25,1); box-shadow: -10px 0 30px rgba(0,0,0,.12); }
.convo-body { --reveal: 0px; overflow-x: hidden; touch-action: pan-y; }
.convo-body .bubble-row, .convo-body .stamp { transform: translateX(calc(-1 * var(--reveal))); }
.convo-body.settling .bubble-row, .convo-body.settling .stamp { transition: transform .3s cubic-bezier(.2,.9,.25,1); }
.bubble-row { position: relative; }
.bubble-time { position: absolute; right: -66px; top: 50%; transform: translateY(-50%); width: 58px; color: rgba(60,60,67,.6); font-size: 12px; white-space: nowrap; }
.bubble { touch-action: pan-y; -webkit-user-select: text; user-select: text; }
.tapback { position: absolute; z-index: 2; top: -16px; right: -12px; min-width: 30px; height: 30px; padding: 0 4px; border-radius: 15px; background: #007aff; color: #fff; display: grid; place-items: center; font: 700 13px/1 var(--ios); box-shadow: 0 0 0 2.5px #fff; animation: mbn-pop .35s cubic-bezier(.2,.9,.3,1.4); }
.tapback-bar { align-self: flex-start; display: flex; gap: 4px; padding: 6px 8px; border-radius: 26px; background: rgba(233,233,235,.96); box-shadow: 0 8px 30px rgba(0,0,0,.18); animation: mbn-lift .28s cubic-bezier(.2,.9,.3,1.3); }
.tapback-bar button { width: 38px; height: 38px; border-radius: 50%; border: 0; background: none; color: #8e8e93; font: 700 16px/1 var(--ios); display: grid; place-items: center; }
.tapback-bar button[aria-pressed="true"] { background: #007aff; color: #fff; }
.ios-overlay .bubble { align-self: flex-start; max-width: 80%; animation: mbn-lift .28s cubic-bezier(.2,.9,.3,1.2); }

/* Mail: hover actions, row swipe, toast */
.mrow .hover-actions { display: none; flex: none; align-items: center; gap: 2px; margin-left: 8px; }
.mrow .hover-actions .icon-btn { width: 32px; height: 32px; }
.mrow:hover .hover-actions, .mrow:focus-within .hover-actions { display: flex; }
.mrow:hover .date, .mrow:focus-within .date { display: none; }
.mrow .star { cursor: pointer; }
.mrow .star[aria-pressed="true"] { color: #f4b400; }
.mrow-swipe { background: #188038; }
.mrow-swipe .swipe-actions { justify-content: space-between; align-items: center; padding: 0 22px; color: #fff; }
.toast { position: absolute; z-index: 20; left: 24px; bottom: 24px; display: flex; align-items: center; gap: 24px; min-width: 288px; max-width: calc(100% - 48px); padding: 14px 16px 14px 24px; border-radius: 4px; background: #303030; color: #f2f2f2; font: 400 14px var(--mail); box-shadow: 0 3px 5px -1px rgba(0,0,0,.2), 0 6px 10px rgba(0,0,0,.14); animation: mbn-toast .25s cubic-bezier(0,0,.2,1); }
.toast button { margin-left: auto; border: 0; background: none; color: #a8c7fa; font: 500 14px var(--mail); padding: 4px 8px; }
.reader.enter, .mail-list.enter { animation: mbn-fadein .18s ease; }

@keyframes mbn-fadein { from { opacity: 0; } to { opacity: 1; } }
@keyframes mbn-headsup { from { opacity: 0; transform: translateY(-70px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes mbn-unstack { from { opacity: 0; transform: translateY(-40px) scale(.94); } to { opacity: 1; transform: none; } }
@keyframes mbn-wake { from { filter: brightness(.25); } to { filter: none; } }
@keyframes mbn-lift { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }
@keyframes mbn-push { from { transform: translateX(100%); } to { transform: none; } }
@keyframes mbn-back { from { transform: translateX(-28%); filter: brightness(.92); } to { transform: none; filter: none; } }
@keyframes mbn-toast { from { opacity: 0; transform: translateY(16px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes mbn-pop { from { transform: scale(.6) translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes mbn-drop { from { transform: translateY(-30px) scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes mbn-fade { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes mbn-rowflash { from { background: #fef7e0; } to { background: #fff; } }
@container (max-width: 980px) { .mail-nav { width: 72px; } .mail-nav .lbl, .mail-nav .n, .compose .lbl { display: none; } .mail-logo { width: auto; } .compose { padding: 0 16px; } .mrow .svc { display: none; } }
@container (max-width: 640px) { .mail-nav, .mail-search, .cat-tabs, .mail-logo .lbl, .mail-toolbar .range { display: none; } .mail-main { margin-left: 8px; } .mrow .from { width: 110px; } .reader .subject-row, .sender-row { padding-left: 16px; } .mail-frame, .mail-text, .attachments, .reply-row, .details { margin-left: 16px; } .mail-frame { width: calc(100% - 32px); } .sender-row { flex-wrap: wrap; } .sender-row .who { flex-basis: calc(100% - 54px); } .sender-row .meta { flex-basis: 100%; padding-left: 54px; white-space: normal; } .reader h1 { font-size: 19px; line-height: 24px; } }
@media (max-width: 760px) { .devices { padding: 16px 8px; } .device-col.wide { flex-basis: 100%; } }
`

/** The stylesheet, every rule scoped to `.mb-notifications`. */
export const STYLES = scopeCss(RAW, `.${ROOT_CLASS}`)

/** Page-level rules for a document that hosts only the harness (the standalone page, Storybook). */
export const PAGE_STYLES =
  "html, body { margin: 0; min-height: 100%; background: #0e1015; color-scheme: dark; } #app { min-height: 100vh; } .boot { padding: 48px; color: #9aa1b1; font: 14px/1.4 system-ui, sans-serif; }"
