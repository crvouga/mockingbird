import { scopeCss } from "./scope-css.js"

/** The class on the UI root. Every rule below is scoped to it. */
export const ROOT_CLASS = "mb-notifications"

/**
 * The device skins: a phone's Messages app and lock screen, an Android notification shade, a
 * webmail client and a team chat window, each in its own platform's type and color, because they
 * imitate what the recipient sees. Everything around them (toolbar, tabs, device headers,
 * timeline, inspector) is the shared Mockingbird UI (HeroUI and the theme in
 * `@crvouga/mockingbird-ui`) and has no rules here. Also the layout of the device frames, which
 * scales with `--mbn-scale` and `--mbn-fit`.
 *
 * Light and dark: every skin color is a custom property below, written once as
 * `light-dark(light, dark)` with the values each platform uses in its own dark mode. The
 * properties are unregistered, so `light-dark()` resolves where a color is used, against the
 * `color-scheme` that cascades there: the system's by default (`:root { color-scheme: light dark }`
 * in Mockingbird's tokens), or the one the theme switch pins with `.light` / `.dark`. Nothing here
 * sets `color-scheme`, so a pin anywhere above the harness reaches the skins. The phone and laptop
 * hardware (bezels, island, punch hole, traffic lights) is the same in both.
 */
const RAW = `
:root {
  --ios: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --android: "Google Sans Text", "Google Sans", Roboto, "Segoe UI", system-ui, sans-serif;
  --mail: "Google Sans", Roboto, RobotoDraft, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  -webkit-tap-highlight-color: transparent;

  /* iOS (Messages, lock screen): UIKit's system colors */
  --ios-bg: light-dark(#fff, #000);
  --ios-label: light-dark(#000, #fff);
  --ios-label-2: light-dark(rgba(60,60,67,.6), rgba(235,235,245,.6));
  --ios-label-3: light-dark(#c4c4c6, rgba(235,235,245,.3));
  --ios-separator: light-dark(#c6c6c8, #38383a);
  --ios-blue: light-dark(#007aff, #0a84ff);
  --ios-yellow: light-dark(#ffcc00, #ffd60a);
  --ios-indigo: light-dark(#5856d6, #5e5ce6);
  --ios-red: light-dark(#ff3b30, #ff453a);
  --ios-fill: light-dark(rgba(118,118,128,.12), rgba(118,118,128,.24));
  --ios-pressed: light-dark(#e5e5ea, #2c2c2e);
  --ios-bar: light-dark(rgba(249,249,249,.94), rgba(29,29,29,.94));
  --ios-bar-edge: light-dark(rgba(0,0,0,.18), rgba(255,255,255,.15));
  --ios-bubble-in: light-dark(#e9e9eb, #26252a);
  --ios-field-edge: light-dark(#c6c6c8, #3a3a3c);
  --ios-placeholder: light-dark(#c4c4c6, #5b5b5f);
  --ios-button-fill: light-dark(#e9e9eb, #2c2c2e);
  --ios-suggestion: light-dark(#d1d3d9, #3a3a3c);
  --ios-suggestion-label: light-dark(#3c3c43, rgba(235,235,245,.6));
  --ios-material: light-dark(rgba(246,246,246,.66), rgba(37,37,37,.62));
  --ios-material-thin: light-dark(rgba(246,246,246,.6), rgba(37,37,37,.6));
  --ios-material-stack: light-dark(rgba(246,246,246,.42), rgba(37,37,37,.44));
  --ios-material-stack-2: light-dark(rgba(246,246,246,.28), rgba(37,37,37,.3));
  --ios-material-edge: light-dark(rgba(255,255,255,.25), rgba(255,255,255,.08));
  --ios-material-label: light-dark(#000, #fff);
  --ios-material-label-2: light-dark(rgba(60,60,67,.62), rgba(235,235,245,.6));
  --ios-material-label-3: light-dark(rgba(60,60,67,.7), rgba(235,235,245,.6));
  --ios-material-well: light-dark(rgba(255,255,255,.55), rgba(0,0,0,.28));
  --ios-material-well-label: light-dark(#1c1c1e, #f2f2f7);
  --ios-menu: light-dark(rgba(237,237,237,.86), rgba(37,37,37,.86));
  --ios-menu-separator: light-dark(rgba(60,60,67,.29), rgba(84,84,88,.6));
  --ios-menu-pressed: light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1));
  --ios-overlay: light-dark(rgba(255,255,255,.28), rgba(0,0,0,.4));
  --ios-overlay-dim: light-dark(rgba(0,0,0,.28), rgba(0,0,0,.45));
  --ios-tapback-bar: light-dark(rgba(233,233,235,.96), rgba(44,44,46,.96));
  /* Dark Mode dims the wallpaper behind the lock screen. */
  --ios-wallpaper-dim: light-dark(transparent, rgba(0,0,0,.3));

  /* WhatsApp on iOS */
  --wa-green: light-dark(#1daa61, #21c063);
  --wa-wallpaper: light-dark(#efeae2, #0b141a);
  --wa-bar: light-dark(rgba(246,246,246,.96), rgba(29,29,29,.96));
  --wa-bubble-in: light-dark(#fff, #202c33);
  --wa-label: light-dark(#000, #e9edef);
  --wa-meta: light-dark(#667781, #8696a0);
  --wa-stamp: light-dark(rgba(255,255,255,.92), #182229);
  --wa-stamp-label: light-dark(#54656f, #8696a0);
  --wa-chip: light-dark(#d9fdd3, #103529);
  --wa-chip-label: light-dark(#0a7a43, #21c063);
  --wa-input-bar: light-dark(#f6f6f6, #1c1c1e);
  --wa-field: light-dark(#fff, #2c2c2e);
  --wa-field-edge: light-dark(#e2e2e2, #3a3a3c);

  /* Android notification shade: Material You */
  --md-scrim: light-dark(rgba(247,242,250,.94), rgba(20,18,24,.94));
  --md-scrim-2: light-dark(rgba(247,242,250,.98), rgba(20,18,24,.98));
  --md-glow: light-dark(#e8def8, #4b3f72);
  --md-surface: light-dark(#f7f2fa, #141218);
  --md-on-surface: light-dark(#1d1b20, #e6e1e5);
  --md-on-surface-variant: light-dark(#49454f, #cac4d0);
  --md-outline: light-dark(#79747e, #938f99);
  --md-outline-variant: light-dark(#cac4d0, #49454f);
  --md-tile: light-dark(#e6e0e9, #36343b);
  --md-primary: light-dark(#6750a4, #d0bcff);
  --md-on-primary: light-dark(#fff, #381e72);
  --md-secondary-container: light-dark(#e8def8, #4a4458);
  --md-card: light-dark(#fffbfe, #2b2930);
  --md-card-chip: light-dark(#e8def8, #49454f);
  --md-well: light-dark(#f3edf7, #1d1b20);
  --md-handle: light-dark(rgba(0,0,0,.6), rgba(255,255,255,.75));

  /* Webmail: Gmail's light and dark themes */
  --mail-chrome: light-dark(#dfe3e9, #202124);
  --mail-omnibox: light-dark(#fff, #35363a);
  --mail-omnibox-label: light-dark(#5f6368, #bdc1c6);
  --mail-bg: light-dark(#f8fafd, #131314);
  --mail-surface: light-dark(#fff, #1f1f1f);
  --mail-label: light-dark(#1f1f1f, #e3e3e3);
  --mail-label-row: light-dark(#202124, #e3e3e3);
  --mail-label-2: light-dark(#5f6368, #a8abaf);
  --mail-label-3: light-dark(#5e5e5e, #a8abaf);
  --mail-icon: light-dark(#444746, #c4c7c5);
  --mail-hover: light-dark(rgba(68,71,70,.08), rgba(227,227,227,.08));
  --mail-search: light-dark(#e9eef6, #2d2f31);
  --mail-compose: light-dark(#c2e7ff, #004a77);
  --mail-on-compose: light-dark(#001d35, #c2e7ff);
  --mail-nav-active: light-dark(#d3e3fd, #004a77);
  --mail-on-nav-active: light-dark(#001d35, #d3e3fd);
  --mail-accent: light-dark(#0b57d0, #a8c7fa);
  --mail-divider: light-dark(#f1f3f4, #2d2f31);
  --mail-outline: light-dark(#dadce0, #444746);
  --mail-row-read: light-dark(#f2f6fc, #19191a);
  --mail-row-unread: light-dark(#fff, #1f1f1f);
  --mail-row-shadow: light-dark(rgba(60,64,67,.3), rgba(0,0,0,.6));
  --mail-row-shadow-2: light-dark(rgba(60,64,67,.15), rgba(0,0,0,.3));
  --mail-row-flash: light-dark(#fef7e0, #3c3523);
  --mail-check: light-dark(#c4c7c5, #8e918f);
  --mail-star: light-dark(#f4b400, #fdd663);
  --mail-chip: light-dark(#ddd, #444746);
  --mail-text: light-dark(#222, #e3e3e3);
  --mail-link: light-dark(#1155cc, #8ab4f8);
  --mail-file: light-dark(#d93025, #f28b82);
  --mail-file-well: light-dark(#f1f3f4, #2d2f31);
  --mail-button-edge: light-dark(#747775, #8e918f);
  --mail-toast: light-dark(#303030, #e3e3e3);
  --mail-on-toast: light-dark(#f2f2f2, #1f1f1f);
  --mail-toast-action: light-dark(#a8c7fa, #0b57d0);

  /* Team chat: Slack's light and dark themes */
  --chat-bg: light-dark(#fff, #1a1d21);
  --chat-label: light-dark(#1d1c1d, #d1d2d3);
  --chat-label-2: light-dark(#616061, #ababad);
  --chat-side: light-dark(#2f1d3a, #19171d);
  --chat-side-label: light-dark(#cfc3d4, #b9babd);
  --chat-side-edge: light-dark(rgba(255,255,255,.1), rgba(255,255,255,.08));
  --chat-side-active: light-dark(#5b3a70, #1164a3);
  --chat-divider: light-dark(#e3e3e3, #35373b);
  --chat-hover: light-dark(#f8f8f8, #222529);
  --chat-new: light-dark(#fffbea, rgba(242,199,68,.1));
  --chat-ephemeral: light-dark(#f6f6f6, #222529);
  --chat-tag: light-dark(#e8e8e8, #35373b);
  --chat-tag-label: light-dark(#555, #ababad);
  --chat-link: light-dark(#1264a3, #1d9bd1);
  --chat-code: light-dark(#f4f4f4, #222529);
  --chat-code-edge: light-dark(#dcdcdc, #35373b);
  --chat-code-label: light-dark(#c0143c, #e8912d);
  --chat-pre: light-dark(#f7f7f7, #222529);
  --chat-mention: light-dark(#e8f1fa, rgba(29,155,209,.1));
  --chat-quote: light-dark(#ddd, #565856);
  --chat-control-edge: light-dark(#bbb, #565856);
  --chat-placeholder: light-dark(#8a8a8a, #9a9b9e);
  --chat-reaction: light-dark(#f0f0f0, #2c2d30);
  --chat-reaction-edge: light-dark(#e0e0e0, #35373b);
  --chat-unknown-edge: light-dark(#ccc, #565856);
}
.mbn-skin, .mbn-skin *, .mbn-skin *::before, .mbn-skin *::after { box-sizing: border-box; }
.mbn-skin button { font: inherit; color: inherit; cursor: pointer; }
.mbn-skin h1, .mbn-skin h2, .mbn-skin h3 { margin: 0; }
.mbn-i { display: contents; }
/* The shared stylesheet's reset makes images and icons blocks; the skins draw them inline, as a
   browser does by default, and place them where they need otherwise. */
.mbn-skin svg, .mbn-skin img { display: inline; vertical-align: baseline; }
[hidden] { display: none !important; }
&[data-motion="reduce"] *, &[data-motion="reduce"] *::before, &[data-motion="reduce"] *::after { animation: none !important; transition: none !important; }
.mbn-skin [role="button"]:focus-visible, .mbn-skin .icon-btn:focus-visible, .mbn-skin [tabindex]:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }

/* ── Device frames: side by side, or one at a time ──────────── */
.devices { display: flex; flex-wrap: wrap; gap: 28px; padding: 20px 16px 40px; align-items: flex-start; justify-content: center; zoom: var(--mbn-scale, 1); }
.devices.solo .device-col.wide { max-width: 1280px; }
.device-col { display: flex; flex-direction: column; gap: 12px; align-items: center; width: 362px; flex: none; }
.device-col.wide { flex: 3 1 480px; width: auto; min-width: 0; max-width: 1180px; align-items: stretch; }
.device-col.wide.chat-col { flex: 2 1 340px; max-width: 760px; }
.devices.solo .device-col.wide.chat-col { max-width: 980px; }
&[data-layout="tabs"] .devices { padding: 14px 8px 32px; gap: 0; }
&[data-layout="tabs"] .device-col.wide { flex-basis: 100%; }
&[data-layout="tabs"] .iphone, &[data-layout="tabs"] .pixel { zoom: var(--mbn-fit, 1); }
&[data-layout="tabs"] .device-col:not(.wide) { width: auto; max-width: 100%; }
&[data-layout="tabs"] .device-col:not(.wide) .device-head { width: calc(362px * var(--mbn-fit, 1)); }
/* ── Phone hardware ─────────────────────────────────────────── */
.iphone { position: relative; width: 362px; height: 760px; border-radius: 58px; padding: 12px; background: #0b0b0c;
  box-shadow: 0 0 0 2px #3a3a3c, 0 0 0 6px #1c1c1e, 0 0 0 7px #4a4a4e, 0 40px 80px rgba(0,0,0,.55); }
.iphone::before, .iphone::after { content: ""; position: absolute; left: -9px; width: 4px; border-radius: 2px; background: #2c2c2e; }
.iphone::before { top: 150px; height: 60px; }
.iphone::after { top: 225px; height: 60px; }
/* clip-path as well as overflow: under zoom, Chromium lets a blurred bar (backdrop-filter) square off the rounded corners. */
.iphone .screen { position: relative; width: 100%; height: 100%; border-radius: 47px; overflow: hidden; clip-path: inset(0 round 47px); background: var(--ios-bg); font-family: var(--ios); color: var(--ios-label); -webkit-font-smoothing: antialiased; }
.island { position: absolute; z-index: 30; top: 11px; left: 50%; transform: translateX(-50%); width: 112px; height: 33px; border-radius: 20px; background: #000; }
.statusbar { position: absolute; z-index: 25; top: 0; left: 0; right: 0; height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 6px 32px 0 40px; font: 600 16px/1 var(--ios); letter-spacing: -.01em; }
.statusbar .icons { display: flex; gap: 6px; align-items: center; }
.statusbar.light { color: #fff; }
.home-indicator { position: absolute; z-index: 30; bottom: 8px; left: 50%; transform: translateX(-50%); width: 134px; height: 5px; border-radius: 3px; background: var(--ios-label); }
.home-indicator.light { background: rgba(255,255,255,.9); }

.pixel { position: relative; width: 352px; height: 760px; border-radius: 44px; padding: 10px; background: #111;
  box-shadow: 0 0 0 2px #2b2b2f, 0 0 0 5px #3c3c41, 0 40px 80px rgba(0,0,0,.55); }
.pixel::after { content: ""; position: absolute; right: -7px; top: 170px; width: 4px; height: 90px; border-radius: 2px; background: #2c2c2e; }
.pixel .screen { position: relative; width: 100%; height: 100%; border-radius: 35px; overflow: hidden; clip-path: inset(0 round 35px); font-family: var(--android); }
.punch { position: absolute; z-index: 30; top: 12px; left: 50%; width: 13px; height: 13px; margin-left: -6px; border-radius: 50%; background: #050505; box-shadow: inset 0 0 0 2px #1a1a1a; }

/* ── Messages (iOS) ─────────────────────────────────────────── */
.msgs { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--ios-bg); }
.msgs-nav { padding: 54px 16px 0; }
.msgs-nav .row { display: flex; justify-content: space-between; align-items: center; height: 44px; color: var(--ios-blue); font-size: 17px; }
.msgs-nav h1 { margin: 2px 0 8px; font: 700 34px/41px var(--ios); letter-spacing: .01em; }
.ios-search { display: flex; align-items: center; gap: 6px; height: 36px; border-radius: 10px; background: var(--ios-fill); color: var(--ios-label-2); padding: 0 8px; font-size: 17px; margin-bottom: 8px; }
.ios-search span { flex: 1; }
.threads { flex: 1; overflow-y: auto; }
.thread { position: relative; display: flex; gap: 12px; padding: 10px 16px 0 26px; cursor: pointer; }
.thread:active { background: var(--ios-pressed); }
.thread .unread { position: absolute; left: 8px; top: 30px; width: 10px; height: 10px; border-radius: 50%; background: var(--ios-blue); }
.avatar { flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 600 18px var(--ios); background: linear-gradient(180deg,#a5abb8,#858994); }
.thread .text { flex: 1; min-width: 0; border-bottom: .5px solid var(--ios-separator); padding-bottom: 10px; }
.thread .top { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.thread .name { font: 600 17px/22px var(--ios); letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread .when { flex: none; color: var(--ios-label-2); font-size: 15px; display: flex; align-items: center; gap: 6px; }
.thread .when .mbn-i { color: var(--ios-label-3); }
.thread .preview { color: var(--ios-label-2); font-size: 15px; line-height: 20px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; letter-spacing: -.01em; }
.empty-ios { flex: 1; display: grid; place-items: center; color: var(--ios-label-2); font-size: 17px; text-align: center; padding: 40px; }

.convo { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--ios-bg); }
.convo-nav { position: relative; z-index: 5; padding-top: 50px; background: var(--ios-bar); backdrop-filter: blur(20px); border-bottom: .5px solid var(--ios-bar-edge); }
.convo-nav .bar { position: relative; height: 96px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
.convo-nav .back { position: absolute; left: 8px; top: 8px; display: flex; align-items: center; color: var(--ios-blue); font-size: 17px; background: none; border: 0; padding: 4px; }
.convo-nav .back .badge { background: var(--ios-blue); color: #fff; border-radius: 10px; font-size: 13px; min-width: 20px; padding: 0 6px; line-height: 20px; margin-left: 2px; }
.convo-nav .avatar { width: 54px; height: 54px; font-size: 22px; }
.convo-nav .who { font-size: 12px; display: flex; align-items: center; gap: 2px; }
.convo-body { flex: 1; overflow-y: auto; padding: 8px 0 12px; }
.stamp { text-align: center; color: var(--ios-label-2); font-size: 12px; margin: 14px 0 6px; }
.stamp b { font-weight: 600; }
.bubble-row { display: flex; padding: 0 14px; margin-top: 2px; }
.bubble-row.gap { margin-top: 10px; }
.bubble { position: relative; max-width: 74%; padding: 7px 12px 8px; border-radius: 18px; background: var(--ios-bubble-in); color: var(--ios-label); font-size: 17px; line-height: 22px; letter-spacing: -.02em; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble.tail::before { content: ""; position: absolute; bottom: 0; left: -7px; width: 20px; height: 20px; background: var(--ios-bubble-in); border-bottom-right-radius: 15px; }
.bubble.tail::after { content: ""; position: absolute; bottom: 0; left: -10px; width: 10px; height: 20px; background: var(--ios-bg); border-bottom-right-radius: 10px; }
.bubble a, .bubble .code { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.bubble .media { display: block; max-width: 100%; border-radius: 12px; margin: 2px 0 4px; }
.bubble.arrive { animation: mbn-pop .35s cubic-bezier(.2,.9,.3,1.3); }
.delivered-note { padding: 2px 16px 0 26px; color: var(--ios-label-2); font-size: 11px; }
.convo-input { display: flex; align-items: flex-end; gap: 8px; padding: 6px 10px 32px; background: var(--ios-bg); }
.convo-input .plus { width: 34px; height: 34px; border-radius: 50%; background: var(--ios-button-fill); display: grid; place-items: center; flex: none; }
.convo-input .field-ios { flex: 1; height: 36px; border: 1px solid var(--ios-field-edge); border-radius: 18px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px 0 14px; color: var(--ios-placeholder); font-size: 17px; }
.qt { margin: 0 10px 6px; padding: 8px 12px; border-radius: 10px; background: var(--ios-suggestion); text-align: center; font-size: 15px; color: var(--ios-label); }
.qt small { display: block; font-size: 12px; color: var(--ios-suggestion-label); }

/* ── Lock screen (iOS) ──────────────────────────────────────── */
.lock { position: absolute; inset: 0; color: #fff; overflow: hidden;
  background: linear-gradient(var(--ios-wallpaper-dim), var(--ios-wallpaper-dim)), radial-gradient(120% 70% at 20% 10%, #6f86ff 0%, transparent 55%), radial-gradient(90% 60% at 90% 30%, #ff7eb3 0%, transparent 60%), radial-gradient(120% 80% at 50% 100%, #1d1b4a 0%, transparent 70%), linear-gradient(180deg,#3a3f9f,#141433); }
.lock .padlock { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); opacity: .95; }
.lock .date { position: absolute; top: 84px; width: 100%; text-align: center; font: 600 19px var(--ios); letter-spacing: .01em; opacity: .92; }
.lock .clock { position: absolute; top: 102px; width: 100%; text-align: center; font: 700 92px/1 "SF Pro Rounded", var(--ios); letter-spacing: -.02em; color: rgba(255,255,255,.93); }
.lock-stack { position: absolute; left: 10px; right: 10px; top: 236px; bottom: 112px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; scrollbar-width: none; }
.lock-stack::-webkit-scrollbar { display: none; }
.lock-stack .center-label { text-align: center; font: 600 15px var(--ios); opacity: .85; padding: 4px 0; }
.ios-note { position: relative; display: flex; gap: 10px; padding: 11px 12px 12px 11px; border-radius: 22px; color: var(--ios-material-label); background: var(--ios-material); backdrop-filter: blur(28px) saturate(180%); -webkit-backdrop-filter: blur(28px) saturate(180%); cursor: pointer; box-shadow: 0 1px 0 var(--ios-material-edge) inset; }
.ios-note.arrive { animation: mbn-drop .45s cubic-bezier(.2,.9,.3,1.15); }
.ios-note .app-icon { flex: none; width: 38px; height: 38px; border-radius: 9px; display: grid; place-items: center; color: #fff; font: 700 18px var(--ios); box-shadow: 0 0 0 .5px rgba(0,0,0,.08); }
.ios-note .content { flex: 1; min-width: 0; }
.ios-note .line1 { display: flex; justify-content: space-between; gap: 8px; }
.ios-note .title { font: 600 15px/20px var(--ios); letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ios-note .time { flex: none; font-size: 13px; color: var(--ios-material-label-2); }
.ios-note .body { font: 400 15px/20px var(--ios); letter-spacing: -.02em; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.ios-note .thumb { flex: none; width: 38px; height: 38px; border-radius: 7px; object-fit: cover; align-self: center; }
.ios-note.expanded .body { -webkit-line-clamp: unset; }
.ios-note .hero { width: 100%; border-radius: 12px; margin-top: 8px; display: block; }
.note-data { margin-top: 8px; font: 12px/1.45 var(--mono); background: var(--ios-material-well); border-radius: 10px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ios-material-well-label); }
.note-meta { margin-top: 6px; font-size: 12px; color: var(--ios-material-label-3); }
.ios-stack-more { position: relative; height: 18px; margin: -14px 14px 0; border-radius: 0 0 18px 18px; background: var(--ios-material-stack); backdrop-filter: blur(20px); }
.ios-stack-more + .ios-stack-more { margin: -10px 26px 0; background: var(--ios-material-stack-2); }
.lock-buttons { position: absolute; bottom: 46px; left: 46px; right: 46px; display: flex; justify-content: space-between; }
.lock-buttons span { width: 50px; height: 50px; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,.28); backdrop-filter: blur(20px); }
.lock-empty { text-align: center; font: 500 15px var(--ios); opacity: .7; margin-top: 30px; }

/* ── Notification shade (Android) ───────────────────────────── */
.shade { position: absolute; inset: 0; color: var(--md-on-surface); background: linear-gradient(180deg, var(--md-scrim), var(--md-scrim-2)), radial-gradient(100% 60% at 30% 0%, var(--md-glow), var(--md-surface)); overflow: hidden; }
.shade .sb { position: absolute; top: 0; left: 0; right: 0; height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 6px 24px 0; font: 500 14px var(--android); color: var(--md-on-surface); }
.shade .sb .icons { display: flex; gap: 5px; align-items: center; }
.shade .qs-head { position: absolute; top: 46px; left: 22px; right: 22px; display: flex; justify-content: space-between; align-items: center; font: 400 15px var(--android); color: var(--md-on-surface-variant); }
.qs { position: absolute; top: 80px; left: 14px; right: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.qs .tile { height: 60px; border-radius: 20px; background: var(--md-tile); display: flex; align-items: center; gap: 10px; padding: 0 14px; font: 500 14px var(--android); color: var(--md-on-surface); min-width: 0; }
.qs .tile > div { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qs .tile svg { flex: none; }
.qs .tile.on { background: var(--md-primary); color: var(--md-on-primary); }
.qs .tile small { display: block; font-weight: 400; font-size: 12px; opacity: .8; }
.qs-bright { position: absolute; top: 216px; left: 14px; right: 14px; height: 44px; border-radius: 22px; background: var(--md-tile); overflow: hidden; }
.qs-bright::before { content: ""; position: absolute; inset: 0 44% 0 0; background: var(--md-primary); border-radius: 22px; }
.shade-list { position: absolute; top: 276px; left: 10px; right: 10px; bottom: 92px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; scrollbar-width: none; }
.shade-list::-webkit-scrollbar { display: none; }
.a-note { background: var(--md-card); border-radius: 6px; padding: 14px 16px 14px 14px; cursor: pointer; display: flex; gap: 12px; }
.a-note:first-child { border-top-left-radius: 26px; border-top-right-radius: 26px; }
.a-note:last-child { border-bottom-left-radius: 26px; border-bottom-right-radius: 26px; }
.a-note.arrive { animation: mbn-headsup .5s cubic-bezier(.2,.9,.3,1.12); }
.a-note .a-icon { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 600 15px var(--android); }
.a-note .a-main { flex: 1; min-width: 0; }
.a-note .a-head { display: flex; align-items: center; gap: 6px; font: 400 12px var(--android); color: var(--md-on-surface-variant); }
.a-note .a-head .chev { margin-left: auto; width: 26px; height: 20px; border-radius: 10px; background: var(--md-card-chip); display: grid; place-items: center; }
.a-note .a-title { font: 500 15px/20px var(--android); color: var(--md-on-surface); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.a-note .a-body { font: 400 14px/20px var(--android); color: var(--md-on-surface-variant); display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.a-note.expanded .a-body { -webkit-line-clamp: unset; }
.a-note .large-icon { flex: none; width: 40px; height: 40px; border-radius: 8px; object-fit: cover; align-self: center; }
.a-note .big-picture { display: block; width: 100%; border-radius: 14px; margin-top: 10px; }
.a-note .note-data { background: var(--md-well); color: var(--md-on-surface); }
.a-note .note-meta { color: var(--md-outline); }
.shade-actions { position: absolute; bottom: 44px; left: 14px; right: 14px; display: flex; justify-content: space-between; }
.shade-actions span { padding: 8px 16px; border-radius: 18px; background: var(--md-tile); font: 500 14px var(--android); color: var(--md-on-surface); }
.shade-empty { text-align: center; color: var(--md-outline); font: 400 14px var(--android); margin-top: 26px; }
.gesture { position: absolute; bottom: 12px; left: 50%; width: 110px; height: 4px; margin-left: -55px; border-radius: 2px; background: var(--md-handle); }

/* ── Mail (web client) ──────────────────────────────────────── */
.window { position: relative; container-type: inline-size; border-radius: 12px; overflow: hidden; background: var(--mail-bg); box-shadow: 0 0 0 1px #2c313c, 0 30px 70px rgba(0,0,0,.5); height: 760px; display: flex; flex-direction: column; font-family: var(--mail); color: var(--mail-label); }
.chrome { flex: none; height: 38px; background: var(--mail-chrome); display: flex; align-items: center; gap: 12px; padding: 0 12px; }
.lights { display: flex; gap: 7px; }
.lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
.lights i:nth-child(1) { background: #ff5f57; } .lights i:nth-child(2) { background: #febc2e; } .lights i:nth-child(3) { background: #28c840; }
.omnibox { flex: 1; max-width: 560px; margin: 0 auto; height: 26px; border-radius: 13px; background: var(--mail-omnibox); display: flex; align-items: center; gap: 8px; padding: 0 12px; color: var(--mail-omnibox-label); font: 13px system-ui; }
.mail-top { flex: none; height: 64px; display: flex; align-items: center; gap: 8px; padding: 8px 16px 8px 12px; }
.icon-btn { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--mail-icon); border: 0; background: none; flex: none; }
.icon-btn:hover { background: var(--mail-hover); }
.mail-logo { display: flex; align-items: center; gap: 6px; width: 194px; font: 400 22px var(--mail); color: var(--mail-icon); letter-spacing: -.01em; }
.mail-search { flex: 1; min-width: 0; max-width: 720px; height: 48px; border-radius: 24px; background: var(--mail-search); display: flex; align-items: center; gap: 4px; padding: 0 4px; color: var(--mail-icon); font-size: 16px; }
.mail-search .placeholder { flex: 1; padding-left: 4px; }
.mail-top .right { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.mail-avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 500 15px var(--mail); margin-left: 8px; }
.mail-body { flex: 1; min-height: 0; display: flex; }
.mail-nav { flex: none; width: 236px; padding: 8px 8px 0 0; overflow: hidden; }
.compose { display: inline-flex; align-items: center; gap: 12px; height: 56px; padding: 0 22px 0 16px; margin: 0 0 16px 8px; border-radius: 16px; background: var(--mail-compose); color: var(--mail-on-compose); font: 500 14px var(--mail); border: 0; box-shadow: none; }
.nav-item { display: flex; align-items: center; gap: 18px; height: 32px; padding: 0 12px 0 26px; border-radius: 0 16px 16px 0; color: var(--mail-label-row); font: 400 14px var(--mail); }
.nav-item.active { background: var(--mail-nav-active); font-weight: 700; color: var(--mail-on-nav-active); }
.nav-item .n { margin-left: auto; font-size: 12px; }
.mail-main { flex: 1; min-width: 0; margin: 0 16px 16px 0; background: var(--mail-surface); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
.mail-toolbar { flex: none; height: 48px; display: flex; align-items: center; gap: 4px; padding: 0 12px 0 14px; color: var(--mail-icon); }
.mail-toolbar .range { margin-left: auto; font-size: 12px; color: var(--mail-icon); }
.cat-tabs { flex: none; display: flex; border-bottom: 1px solid var(--mail-divider); }
.cat-tabs div { flex: 0 1 250px; min-width: 0; height: 54px; display: flex; align-items: center; gap: 16px; padding: 0 16px; color: var(--mail-icon); font: 500 14px var(--mail); position: relative; }
.cat-tabs div.on { color: var(--mail-accent); }
.cat-tabs div.on::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 3px; border-radius: 3px 3px 0 0; background: var(--mail-accent); }
.mail-list { flex: 1; overflow-y: auto; }
.mrow { display: flex; align-items: center; height: 40px; padding: 0 16px 0 12px; border-bottom: 1px solid var(--mail-divider); cursor: pointer; font-size: 14px; color: var(--mail-label-row); background: var(--mail-row-read); }
.mrow.unread { background: var(--mail-row-unread); font-weight: 700; }
.mrow:hover { box-shadow: inset 1px 0 0 var(--mail-outline), inset -1px 0 0 var(--mail-outline), 0 1px 2px 0 var(--mail-row-shadow), 0 1px 3px 1px var(--mail-row-shadow-2); position: relative; z-index: 1; }
.mrow.arrive { animation: mbn-rowflash 1.6s ease-out; }
.mrow .chk, .mrow .star { flex: none; width: 20px; height: 20px; margin-right: 10px; color: var(--mail-check); display: grid; place-items: center; }
.mrow .from { flex: none; width: 168px; padding-right: 24px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrow .subj { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrow .snippet { color: var(--mail-label-2); font-weight: 400; }
.mrow .clip { color: var(--mail-label-2); margin-left: 8px; flex: none; }
.mrow .date { flex: none; width: 78px; text-align: right; font-size: 12px; }
.mrow .svc { flex: none; font: 500 10px var(--mail); color: var(--mail-label-2); border: 1px solid var(--mail-outline); border-radius: 4px; padding: 0 4px; margin-left: 8px; font-weight: 500; text-transform: uppercase; letter-spacing: .03em; }
.mail-empty { padding: 60px 20px; text-align: center; color: var(--mail-label-2); font: 400 14px var(--mail); }
.mail-empty b { display: block; font: 400 22px var(--mail); color: var(--mail-label); margin: 12px 0 4px; }
.reader { flex: 1; overflow-y: auto; padding: 0 0 24px; }
.reader .subject-row { display: flex; align-items: center; gap: 10px; padding: 18px 16px 8px 72px; }
.reader h1 { margin: 0; font: 400 22px/28px var(--mail); color: var(--mail-label); }
.label-chip { font: 400 12px var(--mail); background: var(--mail-chip); border-radius: 4px; padding: 0 6px; color: var(--mail-icon); display: inline-flex; gap: 4px; align-items: center; }
.sender-row { display: flex; gap: 14px; padding: 12px 16px 0 16px; }
.sender-row .mail-avatar { width: 40px; height: 40px; font-size: 18px; margin: 0; }
.sender-row .who { flex: 1; min-width: 0; }
.sender-row .who b { font: 700 14px var(--mail); color: var(--mail-label); }
.sender-row .who .addr { font: 400 12px var(--mail); color: var(--mail-label-3); }
.sender-row .who .to { font: 400 12px var(--mail); color: var(--mail-label-3); display: flex; align-items: center; gap: 2px; margin-top: 2px; }
.sender-row .meta { display: flex; align-items: center; gap: 4px; color: var(--mail-label-3); font: 400 12px var(--mail); white-space: nowrap; }
.details { margin: 8px 16px 0 70px; padding: 10px 14px; border: 1px solid var(--mail-outline); border-radius: 8px; font: 12px/1.6 var(--mail); color: var(--mail-label-3); display: grid; grid-template-columns: max-content 1fr; gap: 0 12px; }
.details span:nth-child(odd) { text-align: right; }
.details span:nth-child(even) { color: var(--mail-label); overflow-wrap: anywhere; }
/* An HTML message keeps the white page it was written for in both themes, as Gmail shows it. */
.mail-frame { display: block; width: calc(100% - 86px); margin: 16px 16px 0 70px; border: 0; min-height: 120px; background: #fff; color-scheme: light; }
.mail-text { margin: 16px 16px 0 70px; white-space: pre-wrap; font: 400 14px/1.55 Arial, sans-serif; color: var(--mail-text); overflow-wrap: anywhere; }
.mail-text a { color: var(--mail-link); }
.attachments { margin: 18px 16px 0 70px; border-top: 1px solid var(--mail-outline); padding-top: 14px; }
.attachments h3 { margin: 0 0 10px; font: 500 14px var(--mail); color: var(--mail-label); }
.att-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.att { width: 180px; height: 104px; border: 1px solid var(--mail-outline); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
.att .att-top { flex: 1; background: var(--mail-file-well); display: grid; place-items: center; color: var(--mail-file); }
.att .att-name { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 10px; font: 500 12px var(--mail); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.att .att-size { color: var(--mail-label-2); font-weight: 400; }
.reply-row { display: flex; gap: 10px; margin: 24px 16px 0 70px; }
.reply-row span { display: inline-flex; align-items: center; gap: 8px; padding: 0 22px 0 16px; height: 36px; border: 1px solid var(--mail-button-edge); border-radius: 18px; font: 500 14px var(--mail); color: var(--mail-icon); }

/* ── Swipe gestures ─────────────────────────────────────────── */
.swipe { position: relative; touch-action: pan-y; }
.swipe > .swipe-card { position: relative; z-index: 1; will-change: transform; }
.swipe.settling > .swipe-card, .settling.a-note { transition: transform .32s cubic-bezier(.2,.9,.25,1), opacity .32s ease; }
.swipe-actions { position: absolute; inset: 0; display: flex; justify-content: flex-end; align-items: stretch; visibility: hidden; }
.swipe.swiping > .swipe-actions, .swipe.open > .swipe-actions { visibility: visible; }
.collapsing { overflow: hidden; transition: height .26s ease, margin .26s ease, padding .26s ease, opacity .2s ease !important; }

/* iOS lock screen: Options / Clear behind a card */
.ios-swipe .swipe-actions { gap: 8px; }
.ios-swipe .swipe-actions button { width: 72px; border: 0; border-radius: 20px; background: var(--ios-material-thin); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); color: var(--ios-material-label); font: 500 14px var(--ios); }
.push-group { display: flex; flex-direction: column; gap: 8px; }
.group-head { display: flex; align-items: center; gap: 8px; padding: 0 2px; animation: mbn-fadein .25s ease; }
.group-head h3 { flex: 1; margin: 0; font: 700 20px/1.2 var(--ios); color: #fff; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-head button { border: 0; border-radius: 15px; background: var(--ios-material-thin); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); color: var(--ios-material-label); font: 500 13px var(--ios); padding: 6px 12px; }
.group-head button.x { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border-radius: 50%; }
.push-group[data-open="true"] .ios-swipe { animation: mbn-unstack .38s cubic-bezier(.2,.9,.3,1.1) backwards; }
.push-group[data-open="true"] .ios-swipe:nth-child(3) { animation-delay: .03s; } .push-group[data-open="true"] .ios-swipe:nth-child(4) { animation-delay: .06s; }
.stack-layers { cursor: pointer; border: 0; padding: 0; background: none; display: block; width: 100%; }
.stack-layers .ios-stack-more:first-child { margin-top: -14px; }
.lock.wake { animation: mbn-wake 1.1s ease-out; }
.ios-overlay { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 0 14px; background: var(--ios-overlay); backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%); animation: mbn-fadein .2s ease; }
.ios-overlay.dark { background: var(--ios-overlay-dim); }
.ios-overlay .ios-note { animation: mbn-lift .3s cubic-bezier(.2,.9,.3,1.2); box-shadow: 0 20px 40px rgba(0,0,0,.25); }
.ios-menu { align-self: flex-start; width: 250px; border-radius: 14px; overflow: hidden; background: var(--ios-menu); backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px); box-shadow: 0 10px 40px rgba(0,0,0,.2); animation: mbn-lift .28s cubic-bezier(.2,.9,.3,1.2); }
.ios-menu button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 11px 16px; border: 0; border-bottom: .5px solid var(--ios-menu-separator); background: none; color: var(--ios-label); font: 400 17px var(--ios); letter-spacing: -.02em; text-align: left; }
.ios-menu button:last-child { border-bottom: 0; }
.ios-menu button:active { background: var(--ios-menu-pressed); }
.ios-overlay.dark .ios-menu { align-self: stretch; width: auto; }

/* Android shade */
.a-note { touch-action: pan-y; position: relative; }
.a-settings { margin-top: 8px; display: grid; gap: 8px; animation: mbn-fadein .2s ease; }
.a-settings .opt { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 16px; border: 1px solid var(--md-outline-variant); font: 500 14px var(--android); color: var(--md-on-surface); background: none; text-align: left; }
.a-settings .opt[aria-pressed="true"] { background: var(--md-secondary-container); border-color: var(--md-primary); }
.a-settings .opt small { display: block; font-weight: 400; color: var(--md-on-surface-variant); font-size: 12px; }
.a-settings .row { display: flex; justify-content: space-between; }
.a-settings .row button { border: 0; background: none; color: var(--md-primary); font: 500 14px var(--android); padding: 6px 4px; }
.shade-actions button { padding: 8px 16px; border: 0; border-radius: 18px; background: var(--md-tile); font: 500 14px var(--android); color: var(--md-on-surface); }

/* Messages: thread swipe actions, page transitions, bubble times, tapbacks */
.thread-swipe .swipe-actions { justify-content: space-between; }
.thread-swipe .swipe-actions .side { display: flex; }
.thread-swipe .swipe-actions button { width: 74px; border: 0; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: 400 13px var(--ios); }
.act-unread { background: var(--ios-blue); } .act-pin { background: var(--ios-yellow); } .act-mute { background: var(--ios-indigo); } .act-delete { background: var(--ios-red); }
.thread-swipe .thread { background: var(--ios-bg); }
.thread .name-line { display: flex; align-items: center; gap: 4px; min-width: 0; }
.thread .flag { flex: none; color: var(--ios-label-2); display: inline-flex; }
.msgs.enter { animation: mbn-back .38s cubic-bezier(.2,.9,.25,1); }
.convo.enter { animation: mbn-push .4s cubic-bezier(.2,.9,.25,1); box-shadow: -10px 0 30px rgba(0,0,0,.12); }
.convo-body { --reveal: 0px; overflow-x: hidden; touch-action: pan-y; }
.convo-body .bubble-row, .convo-body .stamp { transform: translateX(calc(-1 * var(--reveal))); }
.convo-body.settling .bubble-row, .convo-body.settling .stamp { transition: transform .3s cubic-bezier(.2,.9,.25,1); }
.bubble-row { position: relative; }
.bubble-time { position: absolute; right: -66px; top: 50%; transform: translateY(-50%); width: 58px; color: var(--ios-label-2); font-size: 12px; white-space: nowrap; }
.bubble { touch-action: pan-y; -webkit-user-select: text; user-select: text; }
.tapback { position: absolute; z-index: 2; top: -16px; right: -12px; min-width: 30px; height: 30px; padding: 0 4px; border-radius: 15px; background: var(--ios-blue); color: #fff; display: grid; place-items: center; font: 700 13px/1 var(--ios); box-shadow: 0 0 0 2.5px var(--ios-bg); animation: mbn-pop .35s cubic-bezier(.2,.9,.3,1.4); }
.tapback-bar { align-self: flex-start; display: flex; gap: 4px; padding: 6px 8px; border-radius: 26px; background: var(--ios-tapback-bar); box-shadow: 0 8px 30px rgba(0,0,0,.18); animation: mbn-lift .28s cubic-bezier(.2,.9,.3,1.3); }
.tapback-bar button { width: 38px; height: 38px; border-radius: 50%; border: 0; background: none; color: #8e8e93; font: 700 16px/1 var(--ios); display: grid; place-items: center; }
.tapback-bar button[aria-pressed="true"] { background: var(--ios-blue); color: #fff; }
.ios-overlay .bubble { align-self: flex-start; max-width: 80%; animation: mbn-lift .28s cubic-bezier(.2,.9,.3,1.2); }

/* Mail: hover actions, row swipe, toast */
.mrow .hover-actions { display: none; flex: none; align-items: center; gap: 2px; margin-left: 8px; }
.mrow .hover-actions .icon-btn { width: 32px; height: 32px; }
.mrow:hover .hover-actions, .mrow:focus-within .hover-actions { display: flex; }
.mrow:hover .date, .mrow:focus-within .date { display: none; }
.mrow .star { cursor: pointer; }
.mrow .star[aria-pressed="true"] { color: var(--mail-star); }
.mrow-swipe { background: #188038; }
.mrow-swipe .swipe-actions { justify-content: space-between; align-items: center; padding: 0 22px; color: #fff; }
.toast { position: absolute; z-index: 20; left: 24px; bottom: 24px; display: flex; align-items: center; gap: 24px; min-width: 288px; max-width: calc(100% - 48px); padding: 14px 16px 14px 24px; border-radius: 4px; background: var(--mail-toast); color: var(--mail-on-toast); font: 400 14px var(--mail); box-shadow: 0 3px 5px -1px rgba(0,0,0,.2), 0 6px 10px rgba(0,0,0,.14); animation: mbn-toast .25s cubic-bezier(0,0,.2,1); }
.toast button { margin-left: auto; border: 0; background: none; color: var(--mail-toast-action); font: 500 14px var(--mail); padding: 4px 8px; }
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
@keyframes mbn-rowflash { from { background: var(--mail-row-flash); } to { background: var(--mail-row-unread); } }
@container (max-width: 980px) { .mail-nav { width: 72px; } .mail-nav .lbl, .mail-nav .n, .compose .lbl { display: none; } .mail-logo { width: auto; } .compose { padding: 0 16px; } .mrow .svc { display: none; } }
@container (max-width: 480px) { .mrow { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; grid-template-areas: "star from date" ". subj subj"; align-items: center; column-gap: 10px; row-gap: 2px; height: auto; padding: 10px 14px 11px 10px; }
  .mrow .chk, .mrow .svc, .mrow .clip { display: none; } .mrow .star { grid-area: star; margin: 0; } .mrow .from { grid-area: from; width: auto; padding: 0; }
  .mrow:hover .hover-actions, .mrow:focus-within .hover-actions { display: none; }
  .mrow .date { grid-area: date; width: auto; } .mrow .subj { grid-area: subj; white-space: normal; line-height: 19px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; } }
@container (max-width: 640px) { .mail-nav, .mail-search, .cat-tabs, .mail-logo .lbl, .mail-toolbar .range { display: none; } .mail-main { margin-left: 8px; } .mrow .from { width: 110px; } .reader .subject-row, .sender-row { padding-left: 16px; } .mail-frame, .mail-text, .attachments, .reply-row, .details { margin-left: 16px; } .mail-frame { width: calc(100% - 32px); } .sender-row { flex-wrap: wrap; } .sender-row .who { flex-basis: calc(100% - 54px); } .sender-row .meta { flex-basis: 100%; padding-left: 54px; white-space: normal; } .reader h1 { font-size: 19px; line-height: 24px; } }

/* ── WhatsApp: the same phone, a different app ──────────────── */
.avatar.wa { background: linear-gradient(180deg,#5fe08b,#1daa61); }
.thread .via-wa { flex: none; font: 600 10px/16px var(--ios); letter-spacing: .02em; color: var(--wa-chip-label); background: var(--wa-chip); border-radius: 4px; padding: 0 5px; }
.convo.wa { background: var(--wa-wallpaper); }
.convo.wa .convo-nav { background: var(--wa-bar); }
.convo.wa .convo-nav .back { color: var(--wa-green); }
.convo.wa .convo-nav .back svg [stroke] { stroke: var(--wa-green); }
.convo.wa .convo-nav .back svg [fill]:not([fill="none"]) { fill: var(--wa-green); }
.convo.wa .convo-nav .avatar { background: linear-gradient(180deg,#5fe08b,#1daa61); }
.convo.wa .convo-nav .back .badge { background: var(--wa-green); }
.convo.wa .convo-nav .who { flex-direction: column; gap: 0; }
.convo.wa .wa-sub { font: 400 11px/14px var(--ios); color: var(--wa-green); }
.convo.wa .convo-body { background: var(--wa-wallpaper); }
.convo.wa .stamp { width: max-content; max-width: 90%; margin: 12px auto 8px; padding: 3px 10px; border-radius: 8px; background: var(--wa-stamp); color: var(--wa-stamp-label); box-shadow: 0 1px .5px rgba(11,20,26,.13); }
.convo.wa .bubble { background: var(--wa-bubble-in); color: var(--wa-label); border-radius: 8px; border-top-left-radius: 8px; font-size: 16px; line-height: 21px; padding: 6px 9px 7px; box-shadow: 0 1px .5px rgba(11,20,26,.13); }
.convo.wa .bubble.tail { border-bottom-left-radius: 0; }
.convo.wa .bubble.tail::before { left: -7px; width: 8px; height: 12px; background: var(--wa-bubble-in); border-radius: 0; clip-path: polygon(100% 0, 100% 100%, 0 100%); }
.convo.wa .bubble.tail::after { display: none; }
.convo.wa .wa-time { float: right; margin: 9px 0 -3px 10px; font: 400 11px/14px var(--ios); letter-spacing: 0; color: var(--wa-meta); }
.convo.wa .convo-input { background: var(--wa-input-bar); }
.convo.wa .convo-input .plus { background: none; }
.convo.wa .convo-input .field-ios { background: var(--wa-field); border-color: var(--wa-field-edge); }
.convo.wa .otp-bar small { color: var(--wa-green); }

/* ── Chat: a team chat window ───────────────────────────────── */
.window.chat { background: var(--chat-bg); color: var(--chat-label); font-family: "Lato", "Helvetica Neue", Helvetica, "Segoe UI", Arial, sans-serif; }
.window.chat .chrome { flex: none; }
.chat-body { flex: 1; min-height: 0; display: flex; }
.chat-side { flex: none; width: 200px; background: var(--chat-side); color: var(--chat-side-label); padding: 0 8px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.chat-team { display: flex; align-items: center; gap: 4px; padding: 14px 8px 12px; margin: 0 -8px 8px; border-bottom: 1px solid var(--chat-side-edge); color: #fff; font-weight: 800; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-side-label { padding: 6px 8px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
.chat-chan { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: none; color: inherit; text-align: left; padding: 4px 8px; border-radius: 6px; font-size: 14px; min-width: 0; }
.chat-chan:hover { background: rgba(255,255,255,.08); }
.chat-chan .hash { opacity: .7; width: 12px; text-align: center; flex: none; }
.chat-chan .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-chan .n { flex: none; background: #e01e5a; color: #fff; border-radius: 999px; font-size: 11px; line-height: 16px; padding: 0 6px; font-weight: 700; }
.chat-chan.unread { color: #fff; font-weight: 700; }
.chat-chan.on { background: var(--chat-side-active); color: #fff; }
.chat-chan:focus-visible { outline: 2px solid #9ec5ff; outline-offset: -2px; }
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--chat-bg); }
.chat-head { flex: none; display: flex; align-items: baseline; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--chat-divider); }
.chat-head b { font-size: 17px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-head span { color: var(--chat-label-2); font-size: 12px; white-space: nowrap; }
.chat-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0 12px; display: flex; flex-direction: column; }
.chat-list > :first-child { margin-top: auto; }
.chat-day { display: flex; align-items: center; gap: 10px; padding: 8px 18px; color: var(--chat-label-2); font-size: 12px; font-weight: 700; }
.chat-day::before, .chat-day::after { content: ""; flex: 1; height: 1px; background: var(--chat-divider); }
.chat-day span { border: 1px solid var(--chat-divider); border-radius: 999px; padding: 2px 12px; }
.chat-msg { display: flex; gap: 10px; padding: 7px 18px; outline: 0; }
.chat-msg:hover, .chat-msg:focus-visible { background: var(--chat-hover); }
.chat-msg[data-unread="true"] { background: var(--chat-new); }
.chat-msg[data-ephemeral="true"] { background: var(--chat-ephemeral); }
.chat-msg.arrive { animation: mbn-chat-in .3s ease-out; }
@keyframes mbn-chat-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.chat-avatar { flex: none; width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px; }
.chat-msg-main { flex: 1; min-width: 0; font-size: 15px; line-height: 22px; }
.chat-meta { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.chat-meta b { font-weight: 800; }
.chat-app { background: var(--chat-tag); color: var(--chat-tag-label); font-size: 10px; font-weight: 700; border-radius: 3px; padding: 0 4px; line-height: 14px; align-self: center; }
.chat-time, .chat-edited { color: var(--chat-label-2); font-size: 12px; }
.chat-note { color: var(--chat-label-2); font-size: 12px; line-height: 16px; }
.chat-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-text a, .chat-att-title a { color: var(--chat-link); text-decoration: none; }
.chat-text a:hover { text-decoration: underline; }
.chat-code { font: 12px/18px var(--mono); background: var(--chat-code); border: 1px solid var(--chat-code-edge); border-radius: 3px; padding: 1px 3px; color: var(--chat-code-label); }
.chat-pre { font: 12px/18px var(--mono); background: var(--chat-pre); border: 1px solid var(--chat-code-edge); border-radius: 4px; padding: 8px; margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-mention { background: var(--chat-mention); color: var(--chat-link); border-radius: 3px; padding: 0 2px; }
.chat-quote { display: block; border-left: 4px solid var(--chat-quote); padding-left: 10px; margin: 2px 0; }
.chat-blocks, .chat-attachments { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.chat-block-header { font-size: 18px; font-weight: 800; line-height: 24px; }
.chat-block-divider hr { border: 0; border-top: 1px solid var(--chat-divider); margin: 4px 0; }
.chat-block-context { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--chat-label-2); font-size: 13px; }
.chat-block-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.chat-block.with-accessory { display: flex; gap: 12px; align-items: flex-start; }
.chat-section-body { flex: 1; min-width: 0; }
.chat-accessory { flex: none; }
.chat-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin-top: 4px; }
.chat-btn { display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border: 1px solid var(--chat-control-edge); border-radius: 4px; background: var(--chat-bg); font-size: 13px; font-weight: 700; color: var(--chat-label); }
.chat-btn.primary { background: #007a5a; border-color: #007a5a; color: #fff; }
.chat-btn.danger { color: #e01e5a; }
.chat-thumb { width: 72px; height: 72px; border-radius: 6px; object-fit: cover; display: block; }
.chat-block-context .chat-thumb { width: 20px; height: 20px; border-radius: 3px; }
.chat-image { max-width: min(360px, 100%); max-height: 260px; border-radius: 6px; display: block; }
.chat-caption { color: var(--chat-label-2); font-size: 13px; }
.chat-list-block { margin: 2px 0; padding-left: 22px; }
.chat-unknown { color: var(--chat-label-2); font: 12px var(--mono); border: 1px dashed var(--chat-unknown-edge); border-radius: 4px; padding: 2px 6px; }
.chat-attachment { border-left: 4px solid var(--chat-quote); padding-left: 12px; display: flex; flex-direction: column; gap: 2px; }
.chat-att-author { font-size: 13px; font-weight: 700; }
.chat-att-title { font-weight: 700; }
.chat-field { margin-top: 4px; }
.chat-field:not(.short) { grid-column: 1 / -1; }
.chat-att-footer { color: var(--chat-label-2); font-size: 12px; }
.chat-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.chat-reaction { background: var(--chat-reaction); border: 1px solid var(--chat-reaction-edge); border-radius: 999px; padding: 0 8px; font-size: 12px; line-height: 22px; }
.chat-compose { flex: none; display: flex; align-items: center; justify-content: space-between; margin: 0 18px 16px; padding: 0 12px; height: 42px; border: 1px solid var(--chat-control-edge); border-radius: 8px; color: var(--chat-placeholder); font-size: 14px; }
.chat-compose span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-compose .send { display: grid; place-items: center; opacity: .5; }
.chat-empty { margin: auto; padding: 40px 28px; text-align: center; color: var(--chat-label-2); display: flex; flex-direction: column; gap: 6px; max-width: 380px; }
.chat-empty b { color: var(--chat-label); font-size: 16px; }
@container (max-width: 560px) { .chat-side { display: none; } .chat-msg, .chat-head, .chat-day { padding-left: 12px; padding-right: 12px; } .chat-compose { margin: 0 12px 12px; } .chat-fields { grid-template-columns: 1fr; } }

/* ── Phone ──────────────────────────────────────────────────────
   The harness itself is on a phone: the open device fills the screen below the tabs, instead of
   a 760px phone drawn at 362px wide. */
&[data-size="phone"] .devices { zoom: 1; flex: 1 0 auto; min-height: max(440px, calc(100dvh - 200px)); flex-wrap: nowrap; align-items: stretch; padding: 0 12px 12px; gap: 0; }
&.embedded[data-size="phone"] .devices { min-height: 440px; }
&[data-size="phone"] .device-col, &[data-size="phone"] .device-col.wide { flex: 1 1 100%; width: 100%; max-width: none; min-width: 0; align-items: stretch; gap: 0; }
&[data-size="phone"][data-layout="tabs"] .device-col:not(.wide) .device-head { width: 100%; }
&[data-size="phone"] .iphone, &[data-size="phone"] .pixel { zoom: 1; display: flex; flex: 1; width: 100%; height: auto; min-height: 0; border-radius: 40px; padding: 7px;
  box-shadow: 0 0 0 1.5px #3a3a3c, 0 18px 40px rgba(0,0,0,.45); }
&[data-size="phone"] .iphone::before, &[data-size="phone"] .iphone::after, &[data-size="phone"] .pixel::after { display: none; }
&[data-size="phone"] .iphone .screen, &[data-size="phone"] .pixel .screen { flex: 1; height: auto; border-radius: 33px; clip-path: inset(0 round 33px); }
&[data-size="phone"] .window { flex: 1; height: auto; min-height: 0; border-radius: 16px; }
&[data-size="phone"] .window .chrome { display: none; }
`

/** The device skins' stylesheet, every rule scoped to `.mb-notifications`. Pair it with `MOCKINGBIRD_CSS`. */
export const STYLES = scopeCss(RAW, `.${ROOT_CLASS}`)
