/** Inline SVG glyphs drawn for the device skins. Generic shapes; no vendor marks. */
const svg = (w: number, h: number, body: string, extra = "") =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true" ${extra}>${body}</svg>`

const material = (d: string, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`

export const icons = {
  signal: (c = "currentColor") =>
    svg(
      18,
      12,
      `<rect x="0" y="8" width="3" height="4" rx="1" fill="${c}"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="${c}"/><rect x="10" y="3" width="3" height="9" rx="1" fill="${c}"/><rect x="15" y="0" width="3" height="12" rx="1" fill="${c}"/>`,
    ),
  wifi: (c = "currentColor") =>
    svg(
      16,
      12,
      `<path d="M8 2.6c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 8 1 10 10 0 0 0 .9 3.9L2 5c1.6-1.5 3.7-2.4 6-2.4Z" fill="${c}"/><path d="M8 5.9c1.4 0 2.6.5 3.6 1.4l1.1-1.1A6.7 6.7 0 0 0 8 4.3c-1.8 0-3.5.7-4.7 1.9l1.1 1.1c1-.9 2.2-1.4 3.6-1.4Z" fill="${c}"/><path d="M10.3 8.6 8 11 5.7 8.6A3.3 3.3 0 0 1 8 7.6c.9 0 1.7.4 2.3 1Z" fill="${c}"/>`,
    ),
  battery: (c = "currentColor") =>
    svg(
      27,
      13,
      `<rect x=".5" y=".5" width="23" height="12" rx="3.8" stroke="${c}" stroke-opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2.5" fill="${c}"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="${c}" fill-opacity=".45"/>`,
    ),
  compose: () =>
    svg(
      24,
      24,
      `<path d="M19 13v6.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 19.5v-13A1.5 1.5 0 0 1 4.5 5H11" stroke="#007aff" stroke-width="1.8" stroke-linecap="round"/><path d="m9.5 14.5.6-3.1 8.8-8.8a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1l-8.8 8.8-3.6.1Z" stroke="#007aff" stroke-width="1.8" stroke-linejoin="round"/>`,
    ),
  search: (c = "currentColor", s = 16) =>
    svg(
      s,
      s,
      `<circle cx="${s * 0.43}" cy="${s * 0.43}" r="${s * 0.3}" stroke="${c}" stroke-width="${s / 9}"/><path d="m${s * 0.65} ${s * 0.65} ${s * 0.27} ${s * 0.27}" stroke="${c}" stroke-width="${s / 9}" stroke-linecap="round"/>`,
    ),
  mic: (c = "#8e8e93") =>
    svg(
      14,
      20,
      `<rect x="4" y="1" width="6" height="11" rx="3" fill="${c}"/><path d="M1.5 9a5.5 5.5 0 0 0 11 0M7 14.5V18" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`,
    ),
  chevronRight: (c = "#c4c4c6") =>
    svg(
      8,
      13,
      `<path d="m1.5 1.5 5 5-5 5" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
  chevronBack: () =>
    svg(
      13,
      21,
      `<path d="M11 2 2.5 10.5 11 19" stroke="#007aff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
  plus: () =>
    svg(
      16,
      16,
      `<path d="M8 2v12M2 8h12" stroke="#8e8e93" stroke-width="2.2" stroke-linecap="round"/>`,
    ),
  person: () =>
    svg(
      26,
      26,
      `<circle cx="13" cy="9" r="5" fill="#fff"/><path d="M3 24c0-5.5 4.5-9 10-9s10 3.5 10 9" fill="#fff"/>`,
    ),
  padlock: () =>
    svg(
      16,
      21,
      `<rect x="1" y="9" width="14" height="11" rx="2.5" fill="#fff"/><path d="M4 9V6a4 4 0 0 1 8 0v3" stroke="#fff" stroke-width="2"/>`,
    ),
  flashlight: () =>
    svg(
      14,
      22,
      `<path d="M2 1h10v4L9.5 9v11a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V9L2 5V1Z" fill="#fff"/>`,
    ),
  camera: () =>
    svg(
      22,
      18,
      `<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3l1.6-2.2h5.8L15.5 4h3A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 2 15.5v-10Z" fill="#fff"/><circle cx="11" cy="10.3" r="3.6" fill="#555"/>`,
    ),
  bell: () =>
    material(
      "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2Z",
      18,
    ),
  expand: () => material("M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z", 16),
  collapse: () => material("M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z", 16),
  androidWifi: () => material("M12 21 23.6 6.5A17.6 17.6 0 0 0 12 2.5 17.6 17.6 0 0 0 .4 6.5Z", 15),
  androidSignal: () => material("M2 22h20V2Z", 14),
  androidBattery: () =>
    material(
      "M16 4h-2V2h-4v2H8a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z",
      15,
    ),
  menu: () => material("M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z", 24),
  tune: () =>
    material(
      "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
      24,
    ),
  help: () =>
    material(
      "M11 18h2v-2h-2v2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4z",
      24,
    ),
  gear: () =>
    material(
      "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
      24,
    ),
  apps: () =>
    material(
      "M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-6 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0-6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm4-8a2 2 0 1 0 4 0 2 2 0 0 0-4 0zm-4 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      24,
    ),
  pencil: () =>
    material(
      "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
      24,
    ),
  inbox: () =>
    material(
      "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z",
      20,
    ),
  star: () =>
    material(
      "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
      20,
    ),
  clock: () =>
    material(
      "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z",
      20,
    ),
  send: () =>
    material(
      "M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.99.99 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z",
      20,
    ),
  draft: () =>
    material(
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM6 20V4h7v5h5v11H6z",
      20,
    ),
  more: () =>
    material(
      "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      20,
    ),
  refresh: () =>
    material(
      "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
      20,
    ),
  checkbox: () =>
    material(
      "M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
      18,
    ),
  back: () => material("M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z", 20),
  archive: () =>
    material(
      "M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z",
      20,
    ),
  report: () =>
    material(
      "M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM19 14.9 14.9 19H9.1L5 14.9V9.1L9.1 5h5.8L19 9.1v5.8zM11 7h2v6h-2zm0 8h2v2h-2z",
      20,
    ),
  trash: () =>
    material(
      "M15 4V3H9v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9zm4 0h2v9h-2z",
      20,
    ),
  reply: () => material("M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z", 20),
  forward: () => material("M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z", 20),
  clip: () =>
    material(
      "M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z",
      16,
    ),
  file: () =>
    material(
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z",
      28,
    ),
  dropdown: () => material("M7 10l5 5 5-5z", 18),
  lock: () =>
    material(
      "M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6z",
      14,
    ),
  envelope: () =>
    svg(
      30,
      24,
      `<path d="M3 4h24v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4Z" fill="#e8eaed"/><path d="M3 4l12 9 12-9" stroke="#5f6368" stroke-width="2.2" stroke-linejoin="round"/><path d="M3 4h24" stroke="#5f6368" stroke-width="2.2"/>`,
    ),
}
