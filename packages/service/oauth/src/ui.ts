import type { Account } from "./types.js"
export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  )
const style = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--ink:#18181b;--muted:#62626b;--line:#dedee3;--soft:#f4f4f5;--accent:#27272a;--on-accent:#fff;--error:#a82d32;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#111113;--card:#19191c;--ink:#f4f4f5;--muted:#a9a9b2;--line:#36363c;--soft:#242428;--accent:#e4e4e7;--on-accent:#18181b;--error:#ffaaaa}}
.privacy{border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 20px}.privacy legend{font-size:13px;font-weight:600;padding:0 5px}.privacy label{display:flex;align-items:flex-start;gap:10px;margin:10px 0;font-size:14px;cursor:pointer}.privacy input{width:18px;height:18px;min-height:18px;accent-color:var(--accent);flex-shrink:0}.privacy small{display:block;font-size:12px;font-weight:400;color:var(--muted);line-height:1.6;margin-top:3px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);min-height:100svh;display:flex;flex-direction:column}a{color:var(--accent);text-underline-offset:4px}header{padding:28px 5vw;display:flex;align-items:center;gap:12px;font-size:15px;font-weight:650;letter-spacing:-.3px}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--accent);color:var(--on-accent);font-size:21px}.badge{margin-left:auto;border:1px solid var(--line);border-radius:30px;padding:7px 12px;font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}main{width:min(100% - 32px,460px);margin:auto; padding:35px 0 55px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--accent);font-weight:700}h1{font-size:30px;line-height:1.18;letter-spacing:-.5px;font-weight:600;margin:16px 0 12px}p{line-height:1.65;color:var(--muted);font-size:14px;margin:0 0 24px}.app{color:var(--ink);font-weight:600}.accounts{display:grid;gap:10px;margin:26px 0}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.55;cursor:wait}.account{width:100%;display:flex;gap:13px;align-items:center;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px;color:var(--ink)}.account:hover{background:var(--soft);border-color:var(--accent)}.avatar{flex-shrink:0;display:grid;place-items:center;width:40px;height:40px;background:var(--soft);color:var(--accent);border-radius:50%;font-size:15px;font-weight:600}.identity{min-width:0;flex:1}.identity strong,.identity small{display:block;overflow-wrap:anywhere}.identity strong{font-size:14px;font-weight:600}.identity small{font-size:12px;color:var(--muted);margin-top:4px}.arrow{color:var(--muted)}.primary,.secondary{width:100%;min-height:46px;border-radius:11px;padding:12px 16px;font-weight:600;font-size:14px}.primary{background:var(--accent);color:var(--on-accent);border:1px solid var(--accent)}.primary:hover{filter:brightness(1.08)}.secondary{background:transparent;color:var(--ink);border:1px solid var(--line);margin-top:10px}.secondary:hover{background:var(--soft)}label{display:block;font-size:13px;font-weight:600;margin:18px 0 7px}input{width:100%;min-height:46px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);padding:11px 13px;font-size:15px}input:focus{border-color:var(--accent)}:is(a,button,input,select,textarea,summary,[tabindex="0"]):focus-visible{outline:3px solid var(--accent);outline-offset:4px}h1[tabindex="-1"]:focus{outline:none}form{margin:0}.fields{margin:24px 0}.note{font-size:12px;text-align:center;margin:22px 8px 0;line-height:1.7}.divider{height:1px;background:var(--line);margin:25px 0}footer{display:flex;justify-content:center;gap:20px;padding:24px;font-size:11px;color:var(--muted)}.error{color:var(--error);background:var(--soft);border-radius:10px;padding:12px;font-size:13px;margin:18px 0}.permissions{padding:0;list-style:none;margin:22px 0}.permissions li{padding:13px 0;border-bottom:1px solid var(--line);font-size:14px;display:flex;gap:12px}.check{color:var(--accent)}.back{display:block;text-align:center;font-size:13px;margin-top:20px}.empty{padding:20px 0}.skip{position:absolute;top:-100px;left:16px;background:var(--card);padding:12px;z-index:2}.skip:focus{top:10px}@media(max-width:480px){header{padding:20px}.card{padding:26px 23px}main{padding-top:18px}h1{font-size:28px}}@media(prefers-reduced-motion:no-preference){button{transition:background .15s,border-color .15s}.card{animation:arrive .2s ease-out}@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}}
:root:has(input[name="oauth-theme"][value="light"]:checked){color-scheme:light;--bg:#fafafa;--card:#fff;--ink:#18181b;--muted:#62626b;--line:#dedee3;--soft:#f4f4f5;--accent:#27272a;--on-accent:#fff;--error:#a82d32}
:root:has(input[name="oauth-theme"][value="dark"]:checked){color-scheme:dark;--bg:#111113;--card:#19191c;--ink:#f4f4f5;--muted:#a9a9b2;--line:#36363c;--soft:#242428;--accent:#e4e4e7;--on-accent:#18181b;--error:#ffaaaa}
.theme{border:0;padding:0;display:flex;gap:16px;align-items:center}.theme legend{float:left;margin-right:16px;padding:0}.theme label{display:flex;align-items:center;gap:5px;margin:0;font-weight:400;font-size:12px}.theme input{width:14px;height:14px;min-height:0;margin:0;padding:0;accent-color:var(--accent)}

`
export function page(
  title: string,
  body: string,
  status = 200,
  action = "'self'",
  nonce: string = crypto.randomUUID(),
): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · OAuth Mock</title><style nonce="${nonce}">${style}</style></head><body><a class="skip" href="#main">Skip to content</a><header><span>OAuth Mock</span></header><main id="main"><section class="card" aria-labelledby="title">${body}</section><p class="note">Test accounts only.</p></main><footer><fieldset class="theme"><legend>Appearance</legend><label><input type="radio" name="oauth-theme" value="system" checked>System</label><label><input type="radio" name="oauth-theme" value="light">Light</label><label><input type="radio" name="oauth-theme" value="dark">Dark</label></fieldset></footer><script nonce="${nonce}">(()=>{const root=document.documentElement;const inputs=document.querySelectorAll('input[name="oauth-theme"]');const apply=value=>{root.dataset.theme=value;for(const input of inputs)input.checked=input.value===value;try{sessionStorage.setItem('oauth-mock-theme',value)}catch{}};try{const saved=sessionStorage.getItem('oauth-mock-theme');if(['system','light','dark'].includes(saved))apply(saved)}catch{}for(const input of inputs)input.addEventListener('change',()=>apply(input.value))})()</script></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action ${action}; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  )
}
export function loginPage(
  transaction: string,
  client: string,
  accounts: Account[],
  base: string,
  action: string,
  signup = false,
  error = "",
): Response {
  const hidden = `<input type="hidden" name="transaction" value="${escapeHtml(transaction)}">`
  const endpoint = escapeHtml(`${base}/interaction`)
  const intro = `<span class="eyebrow">Sign in</span><h1 id="title">${signup ? "Create your account" : "Choose an account"}</h1><p>${signup ? "Create an account to continue to" : "Choose an account to continue to"}<br><span class="app">${escapeHtml(client)}</span></p>${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}`
  const body = signup
    ? `<form method="post" action="${endpoint}">${hidden}<input type="hidden" name="action" value="signup"><div class="fields"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" required maxlength="120"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" aria-describedby="email-help"><p id="email-help" class="note">Use a fictional address. No email will be sent.</p></div><button class="primary">Create account &amp; continue</button></form><a class="back" href="${endpoint}?transaction=${escapeHtml(transaction)}">Back to accounts</a>`
    : `<div class="accounts">${accounts.map((a) => `<form method="post" action="${endpoint}">${hidden}<input type="hidden" name="action" value="select"><button class="account" name="account" value="${escapeHtml(a.id)}"><span class="avatar" aria-hidden="true">${escapeHtml(a.name.slice(0, 1).toUpperCase())}</span><span class="identity"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.email)}</small></span><span class="arrow" aria-hidden="true">→</span></button></form>`).join("") || '<p class="empty">No accounts yet. Create your first test identity below.</p>'}</div><form method="get" action="${endpoint}">${hidden}<input type="hidden" name="screen" value="signup"><button class="secondary">＋ Create a new account</button></form>`
  return page(
    signup ? "Create account" : "Choose an account",
    `${intro}${body}<div class="divider"></div><form method="post" action="${endpoint}">${hidden}<button class="secondary" name="action" value="deny">Cancel sign-in</button></form>`,
    error ? 400 : 200,
    action,
  )
}
export function consentPage(
  transaction: string,
  client: string,
  account: Account,
  scopes: string,
  base: string,
  action: string,
  privacy?: { hideEmail: boolean; choice: boolean },
): Response {
  const labels: Record<string, string> = {
    openid: "Confirm your identity",
    email: "View your email address",
    profile: "View your name and profile",
    name: "View your name",
    offline_access: "Stay connected when you’re away",
  }
  const privacyFields = privacy
    ? privacy.choice
      ? `<fieldset class="privacy"><legend>Choose what to share</legend><label><input type="radio" name="email_choice" value="share" ${!privacy.hideEmail ? "checked" : ""}><span>Share my email<small>Your app will receive ${escapeHtml(account.email)}.</small></span></label><label><input type="radio" name="email_choice" value="hide" ${privacy.hideEmail ? "checked" : ""}><span>Hide my email<small>Use a private relay address to keep your email private.</small></span></label></fieldset>`
      : `<p>${privacy.hideEmail ? "A private relay address will be shared with this app." : "Your email address will be shared with this app."}</p>`
    : ""
  return page(
    "Review access",
    `<span class="eyebrow">Permissions</span><h1 id="title">Review access</h1><p><span class="app">${escapeHtml(client)}</span> would like access to your account.</p><div class="account"><span class="avatar" aria-hidden="true">${escapeHtml(account.name.slice(0, 1))}</span><span class="identity"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.email)}</small></span></div><ul class="permissions">${scopes
      .split(" ")
      .filter(Boolean)
      .map(
        (s) =>
          `<li><span class="check" aria-hidden="true">✓</span>${escapeHtml(labels[s] ?? s)}</li>`,
      )
      .join(
        "",
      )}</ul><p>You can cancel now without sharing anything.</p><form method="post" action="${escapeHtml(base)}/interaction"><input type="hidden" name="transaction" value="${escapeHtml(transaction)}">${privacyFields}<button class="primary" name="action" value="allow">Allow &amp; continue</button><button class="secondary" name="action" value="deny">Cancel</button></form>`,
    200,
    action,
  )
}
