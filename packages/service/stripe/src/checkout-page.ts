import type { CheckoutSessionRecord } from "./state.js"
import { detailsForNumber, HOSTED_PAGE_TEST_CARDS, type TestCardGroup } from "./test-tokens.js"

/** What the page shows beyond the session itself, looked up by the handler. */
export type CheckoutPageView = {
  session: CheckoutSessionRecord
  merchant: string
  /** The session customer's email, shown read-only the way Checkout does. */
  customerEmail: string | null
  lines: Array<{
    name: string
    description: string | null
    image: string | null
    quantity: number
    unitAmount: number | null
    amount: number
    currency: string
    /** e.g. "month", "3 months"; null for a one-time price. */
    interval: string | null
  }>
  /** Values posted with the last attempt, put back after a decline. */
  values?: Record<string, string>
  error?: string
  notice?: string
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const ZERO_DECIMAL = new Set(
  "bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "),
)

export const formatMoney = (amount: number, currency: string) => {
  const code = currency.toUpperCase()
  const major = ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(major)
  } catch {
    return `${major.toFixed(2)} ${code}`
  }
}

const BRAND_ICONS: Record<string, string> = {
  visa: `<svg viewBox="0 0 32 21" aria-hidden="true"><rect width="32" height="21" rx="3" fill="#fff" stroke="#e3e8ee"/><path fill="#1434cb" d="M13.4 14.3h-1.9l1.2-7.4h1.9l-1.2 7.4zm-3.4-7.4-1.8 5.1-.2-1.1-.7-3.4s-.1-.6-.8-.6H3.6v.1s.9.2 1.9.8l1.6 6.4h2l3-7.4H10zm15.1 7.4h1.7l-1.5-7.4h-1.5c-.7 0-.8.5-.8.5l-2.8 6.9h2l.4-1.1h2.4l.1 1.1zm-2-2.6 1-2.8.6 2.8h-1.6zm-2.8-3-.3-1.6s-.8-.3-1.7-.3c-.9 0-3.1.4-3.1 2.4 0 1.9 2.6 1.9 2.6 2.9s-2.3.8-3.1.2l-.3 1.6s.8.4 2.1.4c1.3 0 3.2-.7 3.2-2.5 0-1.9-2.6-2-2.6-2.9 0-.8 1.8-.7 2.6-.2h.5z"/></svg>`,
  mastercard: `<svg viewBox="0 0 32 21" aria-hidden="true"><rect width="32" height="21" rx="3" fill="#fff" stroke="#e3e8ee"/><circle cx="13" cy="10.5" r="5.5" fill="#eb001b"/><circle cx="19" cy="10.5" r="5.5" fill="#f79e1b"/><path fill="#ff5f00" d="M16 5.9a5.5 5.5 0 0 1 0 9.2 5.5 5.5 0 0 1 0-9.2z"/></svg>`,
  amex: `<svg viewBox="0 0 32 21" aria-hidden="true"><rect width="32" height="21" rx="3" fill="#1f72cd"/><text x="16" y="13.4" text-anchor="middle" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="#fff" letter-spacing=".2">AMEX</text></svg>`,
  discover: `<svg viewBox="0 0 32 21" aria-hidden="true"><rect width="32" height="21" rx="3" fill="#fff" stroke="#e3e8ee"/><path fill="#f58220" d="M13 21h16a3 3 0 0 0 3-3v-6.5C27 16 20 19.6 13 21z"/><text x="13.3" y="12" text-anchor="middle" font-family="Arial,sans-serif" font-size="5.4" font-weight="700" fill="#231f20">DISC</text><circle cx="21.6" cy="10.2" r="2.4" fill="#f58220"/></svg>`,
  unknown: `<svg viewBox="0 0 32 21" aria-hidden="true"><rect width="32" height="21" rx="3" fill="#fff" stroke="#e3e8ee"/><rect x="4" y="5" width="24" height="3" fill="#cfd7df"/><rect x="4" y="12" width="9" height="2.5" rx="1" fill="#cfd7df"/></svg>`,
}

const brandIcon = (brand: string): string => BRAND_ICONS[brand] ?? (BRAND_ICONS.unknown as string)

const CVC_ICON = `<svg viewBox="0 0 32 21" aria-hidden="true"><rect x=".5" y=".5" width="31" height="20" rx="3" fill="#fff" stroke="#cfd7df"/><rect x="0" y="4" width="32" height="4" fill="#cfd7df"/><rect x="17" y="11" width="11" height="5" rx="1" fill="#fff" stroke="#8792a2"/><text x="22.5" y="15" text-anchor="middle" font-family="Arial,sans-serif" font-size="3.6" fill="#697386">123</text></svg>`

const COUNTRIES: Array<[string, string]> = [
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["AU", "Australia"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["IE", "Ireland"],
  ["NL", "Netherlands"],
  ["ES", "Spain"],
  ["IT", "Italy"],
  ["JP", "Japan"],
  ["SG", "Singapore"],
  ["MX", "Mexico"],
  ["BR", "Brazil"],
  ["IN", "India"],
]

const GROUP_LABELS: Record<TestCardGroup, string> = {
  succeeds: "Succeeds",
  declines: "Declines",
  authentication: "Authentication and disputes",
}

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
:root{--text:#1a1a1a;--muted:rgba(26,26,26,.6);--faint:rgba(26,26,26,.4);--line:#e6e6e6;
--accent:#0074d4;--accent-hover:#0063b5;--danger:#df1b41;--ring:rgba(5,115,225,.25);
--test-bg:#ffde92;--test-fg:#983705;
--field:0 0 0 1px #e0e0e0,0 2px 4px 0 rgba(0,0,0,.07),0 1px 1.5px 0 rgba(0,0,0,.05);
--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif}
html,body{margin:0;background:#fff;color:var(--text);font-family:var(--font);font-size:14px;
line-height:1.4;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
.app{min-height:100vh;display:flex;flex-direction:column}
.summary{background:#fff;padding:24px 16px 8px}
.pane{padding:8px 16px 32px}
.inner{max-width:420px;margin:0 auto}
@media (min-width:992px){
  .app{flex-direction:row}
  .summary{flex:1;display:flex;justify-content:flex-end;padding:64px 64px 48px 32px}
  .pane{flex:1;display:flex;justify-content:flex-start;padding:64px 32px 48px 64px;
    box-shadow:15px 0 30px 0 rgba(0,0,0,.18);position:relative}
  .summary .inner,.pane .inner{margin:0;width:380px;max-width:380px}
  .summary .inner{display:flex;flex-direction:column;min-height:calc(100vh - 112px)}
}
.header{display:flex;align-items:center;gap:8px;min-height:28px;margin-bottom:32px}
.back{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;
  background:none;padding:4px 6px 4px 2px;margin-left:-2px;border-radius:6px;cursor:pointer;
  color:var(--text);transition:background .15s}
.back:hover{background:rgba(0,0,0,.05)}
.back svg{width:12px;height:12px;fill:var(--muted);transition:transform .15s}
.back:hover svg{transform:translateX(-2px)}
.merchant{display:inline-flex;align-items:center;gap:10px;font-weight:500;font-size:14px}
.avatar{width:28px;height:28px;border-radius:50%;background:#f0f0f0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06);
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--muted)}
.badge{display:inline-block;margin-left:4px;padding:1px 6px;border-radius:4px;background:var(--test-bg);
  color:var(--test-fg);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase}
.product-label{color:var(--muted);font-size:16px;font-weight:500;margin:0 0 4px}
.amount{font-size:36px;font-weight:600;letter-spacing:-.02em;line-height:1.15;margin:0;
  font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:8px}
.amount small{font-size:14px;font-weight:500;color:var(--muted);letter-spacing:0;line-height:1.2}
.amount-note{color:var(--muted);margin:6px 0 0}
.lines{list-style:none;margin:32px 0 0;padding:0}
.line{display:flex;gap:16px;align-items:flex-start;padding:0 0 20px}
.thumb{flex:none;width:42px;height:42px;border-radius:6px;background:#f6f8fa;
  box-shadow:0 2px 5px rgba(50,50,93,.1),0 1px 1px rgba(0,0,0,.07);overflow:hidden;
  display:flex;align-items:center;justify-content:center}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb svg{width:20px;height:20px;fill:#a3acb9}
.line-body{flex:1;min-width:0}
.line-name{font-weight:500;overflow-wrap:anywhere}
.line-meta{color:var(--muted);font-size:12px;margin-top:2px}
.line-amount{font-weight:500;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.line-amount .line-meta{text-align:right}
.totals{margin:4px 0 0 58px;border-top:1px solid var(--line)}
.totals div{display:flex;justify-content:space-between;padding:14px 0 0;font-variant-numeric:tabular-nums}
.totals .sub{font-weight:500}
.totals .discount span:first-child{display:inline-flex;align-items:center;gap:6px}
.totals .discount span:last-child{color:var(--muted)}
.chip{display:inline-block;padding:2px 8px;border-radius:4px;background:#f0f0f0;font-size:12px;font-weight:500}
.totals .due{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);font-weight:600}
.summary-foot{margin-top:auto;padding-top:48px;display:none;align-items:center;gap:14px;color:var(--faint);font-size:12px}
@media (min-width:992px){.summary-foot{display:flex}}
.pane-foot{display:flex;justify-content:center;align-items:center;gap:14px;color:var(--faint);font-size:12px;margin-top:32px}
@media (min-width:992px){.pane-foot{display:none}}
.powered{display:inline-flex;align-items:center;gap:4px;padding-right:14px;border-right:1px solid var(--line)}
.powered b{font-weight:700;font-size:14px;letter-spacing:-.03em;color:rgba(26,26,26,.5)}
.foot-link{color:inherit;text-decoration:none}
.foot-link:hover{color:var(--muted)}
h2{font-size:16px;font-weight:500;margin:0 0 12px}
section+section{margin-top:28px}
.label{display:block;color:var(--muted);font-size:13px;font-weight:500;margin:0 0 6px}
.field-block+.field-block{margin-top:16px}
.group{border-radius:6px;box-shadow:var(--field);background:#fff;position:relative}
.group input,.group select{display:block;width:100%;border:0;background:transparent;outline:none;
  padding:10px 12px;font-size:16px;line-height:1.5;height:44px;border-radius:0}
.group input::placeholder{color:rgba(26,26,26,.35)}
.row{position:relative}
.row+.row{border-top:1px solid #e0e0e0}
.split{display:flex}
.split>.row{flex:1}
.split>.row+.row{border-top:0;border-left:1px solid #e0e0e0}
.row:not(.split):focus-within{z-index:1;box-shadow:0 0 0 1px rgba(50,151,211,.7),0 0 0 4px var(--ring);border-radius:6px}
.group>.row:first-child:focus-within,.group>.row:first-child{border-radius:6px 6px 0 0}
.group>.row:last-child:focus-within,.group>.row:last-child{border-radius:0 0 6px 6px}
.group>.row:only-child{border-radius:6px}
.group .icons{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;gap:4px;pointer-events:none}
.icons svg{width:24px;height:16px;display:block;transition:opacity .15s,transform .15s}
.icons[data-brand] svg{display:none}
.icons[data-brand] svg.active{display:block;transform:scale(1.1)}
.group .card-input{padding-right:120px}
.group .cvc-input{padding-right:48px}
.row.invalid{box-shadow:0 0 0 1px var(--danger);z-index:1}
.row.invalid input{color:var(--danger)}
.readonly{padding:11px 12px;border-radius:6px;box-shadow:var(--field);background:#fafafa;color:var(--muted);font-size:16px}
select{appearance:none;-webkit-appearance:none;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath fill='%23697386' d='M6 8.5 1.8 4.3l1-1L6 6.5l3.2-3.2 1 1z'/%3E%3C/svg%3E")!important;
  background-repeat:no-repeat!important;background-position:right 12px center!important;background-size:12px!important}
.error{display:flex;gap:6px;align-items:flex-start;color:var(--danger);font-size:13px;margin:8px 0 0}
.error svg{flex:none;width:14px;height:14px;margin-top:2px;fill:currentColor}
.notice{padding:10px 12px;border-radius:6px;background:#f6f8fa;color:var(--muted);margin:0 0 20px}
.pay{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:44px;
  margin-top:28px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;
  cursor:pointer;box-shadow:inset 0 0 0 1px rgba(50,50,93,.1),0 2px 5px 0 rgba(50,50,93,.1),0 1px 1px 0 rgba(0,0,0,.07);
  transition:background .15s,transform .1s}
.pay:hover{background:var(--accent-hover)}
.pay:active{transform:scale(.99)}
.pay:focus-visible{outline:none;box-shadow:0 0 0 4px var(--ring)}
.pay .spinner{display:none;width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.35);
  border-top-color:#fff;animation:spin .7s linear infinite}
.pay .lock{position:absolute;right:16px;width:12px;height:12px;fill:rgba(255,255,255,.7)}
.processing .pay{pointer-events:none}
.processing .pay .text,.processing .pay .lock{display:none}
.processing .pay .spinner{display:block}
@keyframes spin{to{transform:rotate(360deg)}}
.fine{color:var(--muted);font-size:12px;text-align:center;margin:12px 0 0}
.testcards{margin:0 0 28px;border-radius:8px;border:1px solid #f5d37a;background:#fffbf0;overflow:hidden}
.testcards summary{list-style:none;display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none}
.testcards summary::-webkit-details-marker{display:none}
.testcards summary .title{font-weight:600;color:var(--test-fg)}
.testcards summary .hint{color:#a8680a;font-size:12px;margin-left:auto}
.testcards summary .caret{width:10px;height:10px;fill:var(--test-fg);transition:transform .15s}
.testcards[open] summary .caret{transform:rotate(90deg)}
.testcards .body{padding:0 12px 12px;border-top:1px solid #f7e2a8}
.tc-group{margin-top:10px}
.tc-group-label{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#a8680a;margin:0 0 6px}
.tc-grid{display:flex;flex-wrap:wrap;gap:6px}
.tc{display:inline-flex;align-items:center;gap:6px;padding:5px 9px 5px 7px;border-radius:6px;border:0;background:#fff;
  text-align:left;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);
  transition:box-shadow .15s,transform .1s}
.tc:hover{box-shadow:0 0 0 1px rgba(0,0,0,.14),0 3px 6px rgba(0,0,0,.08)}
.tc:active{transform:translateY(1px)}
.tc:focus-visible{outline:none;box-shadow:0 0 0 2px var(--accent)}
.tc svg{flex:none;width:24px;height:16px}
.tc .tc-text{display:inline-flex;align-items:baseline;gap:6px}
.tc .tc-label{font-size:12px;font-weight:500;white-space:nowrap}
.tc .tc-num{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.tc[data-group=succeeds]{border-left:3px solid #1ea672}
.tc[data-group=declines]{border-left:3px solid var(--danger)}
.tc[data-group=authentication]{border-left:3px solid #8d7ffa}
.tc.flash{box-shadow:0 0 0 2px var(--accent)}
.autopay{display:flex;align-items:center;gap:6px;margin-top:12px;font-size:12px;color:var(--muted);cursor:pointer}
.autopay input{margin:0;accent-color:var(--accent)}
.done{text-align:center;padding:32px 0}
.done .mark{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.done .mark svg{width:26px;height:26px;fill:#fff}
.done .ok{background:#1ea672;box-shadow:0 0 0 8px rgba(30,166,114,.12)}
.done .gone{background:#8792a2;box-shadow:0 0 0 8px rgba(135,146,162,.14)}
.done h2{font-size:20px;font-weight:600;margin:0 0 8px}
.done p{color:var(--muted);margin:0}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation-duration:0s!important}}
`

const SCRIPT = `(() => {
  const form = document.getElementById("stripe-mock-form");
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const card = $("card"), exp = $("exp"), cvc = $("cvc"), zip = $("zip"), country = $("country");
  const icons = $("card-icons");
  const brandOf = (digits) =>
    /^3[47]/.test(digits) ? "amex" : /^(6011|65|64[4-9])/.test(digits) ? "discover" :
    /^(5[1-5]|2[2-7])/.test(digits) ? "mastercard" : /^4/.test(digits) ? "visa" : "";
  const formatCard = (event) => {
    const digits = card.value.replace(/\\D/g, "").slice(0, 19);
    const brand = brandOf(digits);
    const groups = brand === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
    const parts = []; let at = 0;
    for (const size of groups) { if (at >= digits.length) break; parts.push(digits.slice(at, at + size)); at += size; }
    card.value = parts.join(" ");
    if (event) card.closest(".row").classList.remove("invalid");
    if (brand) icons.setAttribute("data-brand", brand); else icons.removeAttribute("data-brand");
    for (const icon of icons.querySelectorAll("svg")) icon.classList.toggle("active", icon.dataset.brand === brand);
    cvc.placeholder = brand === "amex" ? "CVV" : "CVC";
    cvc.maxLength = brand === "amex" ? 4 : 3;
  };
  const formatExp = (event) => {
    let digits = exp.value.replace(/\\D/g, "").slice(0, 4);
    if (digits.length === 1 && Number(digits) > 1) digits = "0" + digits;
    const deleting = event && event.inputType === "deleteContentBackward";
    exp.value = digits.length > 2 || (digits.length === 2 && !deleting) ? digits.slice(0, 2) + " / " + digits.slice(2) : digits;
  };
  const formatZip = () => {
    const us = country.value === "US";
    zip.placeholder = us ? "ZIP" : "Postal code";
    zip.inputMode = us ? "numeric" : "text";
    zip.maxLength = us ? 5 : 10;
  };
  card.addEventListener("input", formatCard);
  exp.addEventListener("input", formatExp);
  cvc.addEventListener("input", () => { cvc.value = cvc.value.replace(/\\D/g, ""); });
  country.addEventListener("change", formatZip);
  formatCard(); formatExp(); formatZip();
  form.addEventListener("submit", (event) => {
    if (event.submitter && event.submitter.value === "cancel") return;
    form.classList.add("processing");
  });
  window.addEventListener("pageshow", () => form.classList.remove("processing"));

  const autopay = $("stripe-mock-autopay");
  const KEY = "mockingbird.checkout.autopay";
  if (autopay) {
    try { autopay.checked = localStorage.getItem(KEY) === "1"; } catch {}
    autopay.addEventListener("change", () => { try { localStorage.setItem(KEY, autopay.checked ? "1" : "0"); } catch {} });
  }
  const set = (input, value) => {
    if (!input || input.readOnly) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  for (const button of document.querySelectorAll("[data-test-card]")) {
    button.addEventListener("click", () => {
      const number = button.getAttribute("data-test-card");
      set($("email"), $("email") && $("email").value ? $("email").value : "jenny.rosen@example.com");
      set(card, number);
      set(exp, "12 / 34");
      set(cvc, /^3[47]/.test(number) ? "1234" : "123");
      set($("name"), "Jenny Rosen");
      set(country, "US");
      set(zip, "94107");
      button.classList.add("flash");
      setTimeout(() => button.classList.remove("flash"), 400);
      if (autopay && autopay.checked) form.requestSubmit($("stripe-mock-pay"));
      else $("stripe-mock-pay").focus();
    });
  }
})();`

const ARROW_LEFT = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 7H15a1 1 0 0 1 0 2H3.4l4.3 4.3a1 1 0 0 1-1.4 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 1.4L3.4 7z"/></svg>`
const LOCK = `<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 14.5v-6A1.5 1.5 0 0 1 3.5 7H4zm2 0h4V5a2 2 0 1 0-4 0v2z"/></svg>`
const ALERT = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm0-4.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0-8a1 1 0 0 0-1 1v5a1 1 0 0 0 2 0v-5a1 1 0 0 0-1-1z"/></svg>`
const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 11.6 2.6 8a1 1 0 1 0-1.4 1.4l4.3 4.3a1 1 0 0 0 1.4 0l8-8a1 1 0 0 0-1.4-1.4l-7.3 7.3z"/></svg>`
const CLOCK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm0-2A6 6 0 1 0 8 2a6 6 0 0 0 0 12zm1-6.4 2.7 2.7a1 1 0 0 1-1.4 1.4l-3-3A1 1 0 0 1 7 8V4a1 1 0 1 1 2 0v3.6z"/></svg>`
const CARET = `<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.3 1.3 8.9 6l-4.6 4.7-1-1L6.9 6 3.3 2.3z"/></svg>`
const BOX = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0 15 3.5v9L8 16 1 12.5v-9L8 0zm0 2.2L3.6 4.4 8 6.6l4.4-2.2L8 2.2zM3 6v5.3l4 2V8L3 6zm10 0L9 8v5.3l4-2V6z"/></svg>`

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")

const perInterval = (interval: string | null) => (interval === null ? "" : ` per ${interval}`)

const header = (view: CheckoutPageView, open: boolean) => {
  const merchant = `<span class="merchant"><span class="avatar">${escapeHtml(initials(view.merchant) || "?")}</span><span>${escapeHtml(view.merchant)}</span></span>`
  const back = open
    ? `<button type="submit" form="stripe-mock-form" name="action" value="cancel" formnovalidate class="back" data-testid="stripe-mock-cancel" aria-label="Back to ${escapeHtml(view.merchant)}">${ARROW_LEFT}${merchant}</button>`
    : merchant
  return `<div class="header">${back}<span class="badge">Test mode</span></div>`
}

const headline = (view: CheckoutPageView) => {
  const { session, lines } = view
  const first = lines[0]
  const single = lines.length === 1 && first !== undefined
  const total = formatMoney(session.amount_total, session.currency)
  if (session.mode === "setup")
    return `<p class="product-label">Set up future payments with ${escapeHtml(view.merchant)}</p>
<p class="amount" style="font-size:24px">Save your card</p>
<p class="amount-note">You won't be charged now.</p>`
  if (session.mode === "subscription") {
    const interval = first?.interval ?? null
    const trialDays =
      session.subscription_data?.trial_end == null
        ? 0
        : Math.max(0, Math.round((session.subscription_data.trial_end - session.created) / 86_400))
    const label = single ? `Subscribe to ${escapeHtml(first.name)}` : "Subscribe"
    const recurring = lines.reduce((sum, line) => sum + line.amount, 0)
    if (trialDays > 0)
      return `<p class="product-label">Try ${escapeHtml(single ? first.name : view.merchant)}</p>
<p class="amount" data-testid="stripe-mock-total">${trialDays} days free</p>
<p class="amount-note">Then ${formatMoney(recurring, session.currency)}${perInterval(interval)}</p>`
    const [unit, ...rest] = perInterval(interval).trim().split(" ")
    return `<p class="product-label">${label}</p>
<p class="amount" data-testid="stripe-mock-total"><span>${total}</span>${interval === null ? "" : `<small>${escapeHtml(unit ?? "")}<br>${escapeHtml(rest.join(" "))}</small>`}</p>`
  }
  const label = single ? escapeHtml(first.name) : `Pay ${escapeHtml(view.merchant)}`
  return `<p class="product-label">${label}</p>
<p class="amount" data-testid="stripe-mock-total">${total}</p>`
}

const billedEvery = (interval: string) =>
  /^\d/.test(interval) ? `every ${interval}` : interval === "day" ? "daily" : `${interval}ly`

const lineItems = (view: CheckoutPageView) => {
  const { session, lines } = view
  if (session.mode === "setup" || lines.length === 0) return ""
  const items = lines
    .map((line) => {
      const thumb = line.image
        ? `<img src="${escapeHtml(line.image)}" alt="">`
        : BOX.replace("<svg", '<svg role="presentation"')
      const each =
        line.quantity > 1 && line.unitAmount !== null
          ? `<div class="line-meta">${formatMoney(line.unitAmount, line.currency)} each</div>`
          : ""
      const billed =
        line.interval === null
          ? ""
          : `<div class="line-meta">Billed ${escapeHtml(billedEvery(line.interval))}</div>`
      return `<li class="line" data-testid="stripe-mock-line">
<div class="thumb">${thumb}</div>
<div class="line-body"><div class="line-name">${escapeHtml(line.name)}</div>
${line.description ? `<div class="line-meta">${escapeHtml(line.description)}</div>` : ""}
<div class="line-meta">Qty ${line.quantity}</div></div>
<div class="line-amount">${formatMoney(line.amount, line.currency)}${each}${billed}</div></li>`
    })
    .join("")
  const discount = session.amount_discount ?? session.amount_subtotal - session.amount_total
  const rows = [
    `<div class="sub"><span>Subtotal</span><span>${formatMoney(session.amount_subtotal, session.currency)}</span></div>`,
    discount > 0
      ? `<div class="discount"><span><span class="chip">Discount</span></span><span>−${formatMoney(discount, session.currency)}</span></div>`
      : "",
    `<div class="due"><span>Total due today</span><span>${formatMoney(session.amount_total, session.currency)}</span></div>`,
  ]
  return `<ul class="lines">${items}</ul><div class="totals">${rows.join("")}</div>`
}

const footer = (className: string) =>
  `<div class="${className}"><span class="powered">Powered by <b>stripe</b></span><a class="foot-link" href="https://stripe.com/legal/end-users" rel="noreferrer">Terms</a><a class="foot-link" href="https://stripe.com/privacy" rel="noreferrer">Privacy</a></div>`

const testCards = () => {
  const groups = (Object.keys(GROUP_LABELS) as TestCardGroup[])
    .map((group) => {
      const cards = HOSTED_PAGE_TEST_CARDS.filter((card) => card.group === group)
        .map(
          (card) =>
            `<button type="button" class="tc" data-group="${group}" data-test-card="${card.number}" data-testid="stripe-mock-test-card" title="${escapeHtml(`${card.hint} — ${card.number}`)}">${brandIcon(detailsForNumber(card.number).brand)}<span class="tc-text"><span class="tc-label">${escapeHtml(card.label)}</span><span class="tc-num">${card.number.slice(-4)}</span></span></button>`,
        )
        .join("")
      return `<div class="tc-group"><p class="tc-group-label">${GROUP_LABELS[group]}</p><div class="tc-grid">${cards}</div></div>`
    })
    .join("")
  return `<details class="testcards" open data-testid="stripe-mock-test-cards"><summary>${CARET}<span class="title">Test cards</span><span class="hint">Click to fill the form</span></summary>
<div class="body">${groups}<label class="autopay"><input type="checkbox" id="stripe-mock-autopay" data-testid="stripe-mock-autopay"> Pay immediately after filling</label></div></details>`
}

const payLabel = (session: CheckoutSessionRecord) =>
  session.mode === "setup"
    ? "Save card"
    : session.mode === "subscription"
      ? session.subscription_data?.trial_end
        ? "Start trial"
        : "Subscribe"
      : session.amount_total === 0
        ? "Complete order"
        : `Pay ${formatMoney(session.amount_total, session.currency)}`

const submitMessage = (session: CheckoutSessionRecord): string | null => {
  const submit = session.custom_text?.submit as { message?: unknown } | null | undefined
  return typeof submit?.message === "string" ? submit.message : null
}

const paymentForm = (view: CheckoutPageView) => {
  const values = view.values ?? {}
  const value = (key: string) => (values[key] ? ` value="${escapeHtml(values[key])}"` : "")
  const country = values.country ?? "US"
  const email = view.customerEmail
    ? `<div class="readonly" data-testid="stripe-mock-email-readonly">${escapeHtml(view.customerEmail)}</div>`
    : `<div class="group"><div class="row"><input id="email" name="email" type="email" data-testid="stripe-mock-email" autocomplete="email" placeholder="email@example.com"${value("email")}></div></div>`
  const icons = ["visa", "mastercard", "amex", "discover"]
    .map((brand) => brandIcon(brand).replace("<svg", `<svg data-brand="${brand}"`))
    .join("")
  const error = view.error
    ? `<p class="error" role="alert" data-testid="stripe-mock-error">${ALERT}<span>${escapeHtml(view.error)}</span></p>`
    : ""
  const message = submitMessage(view.session)
  return `<form method="post" id="stripe-mock-form" data-testid="stripe-mock-form" novalidate>
${testCards()}
${view.notice ? `<p class="notice" role="status">${escapeHtml(view.notice)}</p>` : ""}
<section><h2>Contact information</h2>
<label class="label" for="email">Email</label>${email}</section>
<section><h2>Payment method</h2>
<div class="field-block"><label class="label" for="card">Card information</label>
<div class="group">
<div class="row${view.error ? " invalid" : ""}"><input id="card" name="card" class="card-input" data-testid="stripe-mock-card" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234"${value("card")}><span class="icons" id="card-icons">${icons}</span></div>
<div class="row split"><div class="row"><input id="exp" name="exp" data-testid="stripe-mock-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / YY" aria-label="Expiration"${value("exp")}></div>
<div class="row"><input id="cvc" name="cvc" class="cvc-input" data-testid="stripe-mock-cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="CVC" aria-label="CVC"${value("cvc")}><span class="icons">${CVC_ICON}</span></div></div>
</div>${error}</div>
<div class="field-block"><label class="label" for="name">Cardholder name</label>
<div class="group"><div class="row"><input id="name" name="name" data-testid="stripe-mock-name" autocomplete="cc-name" placeholder="Full name on card"${value("name")}></div></div></div>
<div class="field-block"><label class="label" for="country">Country or region</label>
<div class="group"><div class="row"><select id="country" name="country" data-testid="stripe-mock-country" autocomplete="country">${COUNTRIES.map(([code, name]) => `<option value="${code}"${code === country ? " selected" : ""}>${name}</option>`).join("")}</select></div>
<div class="row"><input id="zip" name="zip" data-testid="stripe-mock-zip" autocomplete="postal-code" placeholder="ZIP" aria-label="ZIP"${value("zip")}></div></div></div>
</section>
<button type="submit" name="action" value="pay" class="pay" data-testid="stripe-mock-pay"><span class="text">${escapeHtml(payLabel(view.session))}</span><span class="spinner" aria-hidden="true"></span>${LOCK}</button>
${message ? `<p class="fine">${escapeHtml(message)}</p>` : ""}
${
  view.session.mode === "payment"
    ? ""
    : `<p class="fine">By confirming, you allow ${escapeHtml(view.merchant)} to charge your card for future payments in accordance with their terms.</p>`
}
</form>`
}

const closed = (view: CheckoutPageView) => {
  const { session } = view
  const complete = session.status === "complete"
  const title = complete
    ? session.mode === "setup"
      ? "Card saved"
      : session.mode === "subscription"
        ? "Subscription confirmed"
        : "Thanks for your payment"
    : "This checkout session has expired"
  const body = complete
    ? `A receipt for this ${session.mode === "setup" ? "setup" : "purchase"} would be sent by ${escapeHtml(view.merchant)}.`
    : `Return to ${escapeHtml(view.merchant)} to start again.`
  return `<div class="done" data-testid="stripe-mock-closed">
<div class="mark ${complete ? "ok" : "gone"}">${complete ? CHECK : CLOCK}</div>
<h2>${title}</h2><p>${body}</p>
<p style="margin-top:14px"><span class="chip">This Checkout Session is ${escapeHtml(session.status)}.</span></p>
${view.notice ? `<p class="notice" role="status" style="margin-top:20px">${escapeHtml(view.notice)}</p>` : ""}
</div>`
}

/**
 * The hosted Checkout page served in place of checkout.stripe.com, laid out like Stripe's: the
 * order summary on the left, the payment form on the right (stacked on narrow screens), with a
 * test-card panel that fills every field in one click. Stable `data-testid`s let UI suites
 * drive it (`stripe-mock-card`, `-exp`, `-cvc`, `-zip`, `-pay`, `-cancel`, `-test-card`).
 */
export const checkoutPage = (view: CheckoutPageView) => {
  const { session } = view
  const open = session.status === "open"
  return `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(view.merchant)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLES}</style></head>
<body data-testid="stripe-mock-checkout" data-session-id="${escapeHtml(session.id)}" data-status="${session.status}" data-mode="${escapeHtml(session.mode)}">
<div class="app">
<aside class="summary"><div class="inner">
${header(view, open)}
<span hidden data-testid="stripe-mock-mode">${escapeHtml(session.mode)}</span>
${headline(view)}
${lineItems(view)}
${footer("summary-foot")}
</div></aside>
<main class="pane"><div class="inner">
${open ? paymentForm(view) : closed(view)}
${footer("pane-foot")}
</div></main>
</div>
${open ? `<script>${SCRIPT}</script>` : ""}
</body></html>`
}
