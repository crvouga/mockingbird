/**
 * Look and feel of the Stripe.js stand-in's Elements: brand icons, the card Element stylesheet
 * (themed with Stripe's `style` / `classes` options) and the Payment Element stylesheet (themed
 * with the Appearance API: `theme`, `variables`, `rules`, `labels`, `inputs`). Every stylesheet
 * is written against `%S`, which the script replaces with a selector unique to one mounted
 * Element, so Elements never restyle each other and host-page `input` / `label` rules lose to them.
 */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 16" width="24" height="16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`

/** 24×16 card-brand and state icons. `unknown`, `cvc` and `error` follow `currentColor`. */
export const ICONS: Record<string, string> = {
  unknown: svg(
    '<rect width="24" height="16" rx="2.5" fill="currentColor" opacity=".22"/><rect y="3.5" width="24" height="2.6" fill="currentColor" opacity=".45"/><rect x="3" y="9.6" width="7" height="1.8" rx=".9" fill="currentColor" opacity=".55"/><rect x="11.5" y="9.6" width="3.5" height="1.8" rx=".9" fill="currentColor" opacity=".55"/>',
  ),
  visa: svg(
    '<rect width="24" height="16" rx="2.5" fill="#1434CB"/><text x="12" y="10.9" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="7.2" font-weight="700" font-style="italic" letter-spacing=".1" fill="#fff">VISA</text>',
  ),
  mastercard: svg(
    '<rect width="24" height="16" rx="2.5" fill="#16161D"/><circle cx="9.5" cy="8" r="4.6" fill="#EB001B"/><circle cx="14.5" cy="8" r="4.6" fill="#F79E1B"/><path d="M12 4.14A4.6 4.6 0 0 1 12 11.86A4.6 4.6 0 0 1 12 4.14z" fill="#FF5F00"/>',
  ),
  amex: svg(
    '<rect width="24" height="16" rx="2.5" fill="#1F72CD"/><text x="12" y="10.2" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="5.6" font-weight="700" letter-spacing=".2" fill="#fff">AMEX</text>',
  ),
  discover: svg(
    '<rect x=".5" y=".5" width="23" height="15" rx="2" fill="#fff" stroke="#D9DCE1"/><path d="M9 15.5L23.5 9v4.5a2 2 0 0 1-2 2z" fill="#F48024"/><text x="12" y="8.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="3.9" font-weight="700" fill="#231F20">DISCOVER</text>',
  ),
  cvc: svg(
    '<rect width="24" height="16" rx="2.5" fill="currentColor" opacity=".22"/><rect y="2.6" width="24" height="3" fill="currentColor" opacity=".6"/><rect x="2.5" y="8.2" width="13" height="3.2" rx=".8" fill="currentColor" opacity=".3"/><rect x="15.6" y="7.2" width="6.4" height="5.2" rx="1.2" stroke="currentColor" stroke-width="1.1"/><text x="18.8" y="11" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="3.4" font-weight="700" fill="currentColor">123</text>',
  ),
  cvcAmex: svg(
    '<rect width="24" height="16" rx="2.5" fill="currentColor" opacity=".22"/><rect x="2.5" y="10.6" width="10" height="1.8" rx=".9" fill="currentColor" opacity=".45"/><rect x="13.4" y="3" width="8.6" height="5.2" rx="1.2" stroke="currentColor" stroke-width="1.1"/><text x="17.7" y="6.8" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="3.4" font-weight="700" fill="currentColor">1234</text>',
  ),
  error: svg(
    '<rect x=".6" y=".6" width="22.8" height="14.8" rx="2.2" stroke="currentColor" stroke-width="1.2"/><rect x="11.1" y="3.6" width="1.8" height="5.6" rx=".9" fill="currentColor"/><circle cx="12" cy="11.6" r="1.05" fill="currentColor"/>',
  ),
}

const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif'

/** The classic card Element and its split siblings: one unboxed line, like Stripe's iframe. */
export const CARD_CSS = `
%S{display:flex;align-items:center;width:100%;min-width:0;margin:0;padding:0;border:0;background:transparent;font-family:${SYSTEM_FONT};font-size:16px;font-weight:400;line-height:1.2em;color:#32325d;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-align:left;cursor:text}
%S *,%S *::before,%S *::after{box-sizing:border-box}
%S .mbs-Icon{flex:0 0 auto;display:inline-flex;width:1.5em;height:1em;margin-right:.75em;color:#aab7c4;transition:color .15s ease}
%S .mbs-Icon svg{display:block;width:100%;height:100%}
%S .mbs-Icon--invalid{color:#eb1c26}
%S .mbs-Field{position:relative;display:block;flex:0 0 auto;min-width:0;margin:0;padding:0}
%S .mbs-Field--card{flex:1 1 auto}
%S .mbs-Field--exp{width:4.6em;margin-left:.75em}
%S .mbs-Field--cvc{width:3.1em;margin-left:.75em}
%S .mbs-Field--zip{width:4.4em;margin-left:.75em}
%S.mbs--split .mbs-Field{flex:1 1 auto;width:auto;margin-left:0}
%S .mbs-hidden{display:none}
%S input.mbs-Input{all:unset;box-sizing:border-box;display:block;width:100%;height:1.2em;margin:0;padding:0;border:0;background:transparent;font:inherit;line-height:inherit;letter-spacing:inherit;color:inherit;text-align:inherit;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;cursor:text;caret-color:currentColor}
%S input.mbs-Input::placeholder{color:#aab7c4;opacity:1}
%S input.mbs-Input::-ms-clear{display:none}
%S input.mbs-Input:disabled{cursor:default}
%S input.mbs-Input:-webkit-autofill{-webkit-text-fill-color:currentColor;transition:background-color 100000s 0s}
%S .mbs-Field--invalid input.mbs-Input{color:#eb1c26}
`

/** The Payment Element under the default `stripe` theme; other themes layer on top. */
export const PAYMENT_CSS = `
%S{--colorPrimary:#0570de;--colorBackground:#ffffff;--colorText:#30313d;--colorDanger:#df1b41;--colorSuccess:#30b130;--colorWarning:#f59e0b;--colorTextSecondary:#6d6e78;--colorTextPlaceholder:#757680;--colorIcon:var(--colorTextSecondary);--colorBorder:color-mix(in srgb,var(--colorText) 12%,var(--colorBackground));--fontFamily:${SYSTEM_FONT};--fontSizeBase:1rem;--fontSizeSm:calc(var(--fontSizeBase) * .93);--fontWeightNormal:400;--fontWeightMedium:600;--fontLineHeight:1.15;--spacingUnit:2px;--borderRadius:5px;--gridRowSpacing:calc(var(--spacingUnit) * 6);--gridColumnSpacing:calc(var(--spacingUnit) * 6);--inputPadding:calc(var(--spacingUnit) * 6);--focusBoxShadow:0 0 0 3px color-mix(in srgb,var(--colorPrimary) 25%,transparent);--focusOutline:0}
%S{display:block;width:100%;min-width:0;margin:0;padding:0;border:0;background:transparent;font-family:var(--fontFamily);font-size:var(--fontSizeBase);font-weight:var(--fontWeightNormal);line-height:var(--fontLineHeight);color:var(--colorText);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-align:left}
%S *,%S *::before,%S *::after{box-sizing:border-box}
%S .mbs-hidden{display:none !important}
%S .mbs-Group + .mbs-Group{margin-top:var(--gridRowSpacing)}
%S .mbs-Grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:var(--gridColumnSpacing);row-gap:var(--gridRowSpacing)}
%S .mbs-Span{grid-column:1 / -1}
%S .mbs-Field{position:relative;min-width:0;margin:0;padding:0}
%S .mbs-Control{position:relative}
%S input,%S select,%S label{all:unset}
%S .mb-Label{box-sizing:border-box;display:block;margin:0 0 calc(var(--spacingUnit) * 2);font-family:inherit;font-size:var(--fontSizeSm);font-weight:var(--fontWeightNormal);line-height:var(--fontLineHeight);color:var(--colorText);cursor:default;transition:transform .15s ease,color .15s ease,opacity .15s ease}
%S .mb-Input{box-sizing:border-box;display:block;width:100%;min-height:calc(var(--fontSizeBase) * var(--fontLineHeight) + var(--inputPadding) * 2 + 2px);margin:0;padding:var(--inputPadding);font-family:inherit;font-size:var(--fontSizeBase);font-weight:var(--fontWeightNormal);line-height:var(--fontLineHeight);letter-spacing:normal;color:var(--colorText);background-color:var(--colorBackground);border:1px solid var(--colorBorder);border-radius:var(--borderRadius);box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02);outline:var(--focusOutline);transition:background .15s ease,border .15s ease,box-shadow .15s ease,color .15s ease;cursor:text;caret-color:var(--colorText);text-overflow:ellipsis;white-space:nowrap}
%S .mb-Input::placeholder{color:var(--colorTextPlaceholder);opacity:1}
%S .mb-Input:-webkit-autofill{-webkit-text-fill-color:var(--colorText);box-shadow:0 0 0 1000px var(--colorBackground) inset}
%S .mb-Input:focus{position:relative;z-index:1;border-color:color-mix(in srgb,var(--colorPrimary) 50%,transparent);box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02),var(--focusBoxShadow);outline:var(--focusOutline)}
%S .mb-Input:disabled{opacity:.6;cursor:default}
%S .mb-Input--invalid{color:var(--colorDanger);border-color:var(--colorDanger);box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02),0 0 0 1px var(--colorDanger)}
%S .mb-Input--invalid:focus{border-color:var(--colorDanger);box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02),0 0 0 1px var(--colorDanger),0 0 0 4px color-mix(in srgb,var(--colorDanger) 25%,transparent)}
%S select.mb-Input{cursor:pointer;padding-right:calc(var(--inputPadding) + 20px);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23878892' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right var(--inputPadding) center;background-size:12px 12px}
%S select.mb-Input option{color:#30313d;background:#fff}
%S .mbs-Icons{position:absolute;z-index:2;top:50%;right:calc(var(--inputPadding) + 1px);display:flex;gap:4px;transform:translateY(-50%);pointer-events:none;color:var(--colorIcon)}
%S .mbs-Icons span{display:block}
%S .mbs-Icons svg{display:block;width:24px;height:16px;border-radius:3px}
%S .mbs-Icons--1 .mb-Input{padding-right:calc(var(--inputPadding) + 32px)}
%S .mbs-Icons--4 .mb-Input{padding-right:calc(var(--inputPadding) + 116px)}
%S .mbs-Icon-in{animation:mbs-pop .2s ease}
@keyframes mbs-pop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
%S .mb-Error{display:block;margin-top:calc(var(--spacingUnit) * 2);font-size:var(--fontSizeSm);line-height:var(--fontLineHeight);color:var(--colorDanger)}
%S .mbs-Floating .mb-Label{position:absolute;z-index:2;top:0;left:calc(var(--inputPadding) + 1px);right:calc(var(--inputPadding) + 1px);margin:0;font-size:var(--fontSizeBase);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transform-origin:0 0;pointer-events:none;color:var(--colorTextSecondary)}
%S .mbs-Floating .mb-Label--resting{transform:translateY(calc(var(--inputPadding) + 1px))}
%S .mbs-Floating .mb-Label--floating{transform:translateY(calc(var(--spacingUnit) * 2.5)) scale(.78)}
%S .mbs-Floating .mb-Input{padding-top:calc(var(--inputPadding) + var(--spacingUnit) * 4);padding-bottom:calc(var(--inputPadding) - var(--spacingUnit) * 4 + 4px)}
%S .mbs-Floating select.mb-Input{background-position:right var(--inputPadding) center}
%S .mbs-Floating .mb-Input--empty:not(:focus)::placeholder{color:transparent}
%S .mbs-Body .mbs-GroupLabel{display:none}
%S .mbs-Condensed:not(.mbs-Floating) .mbs-GroupLabel{display:block;position:static;transform:none}
%S .mbs-Condensed .mbs-Grid{row-gap:0;column-gap:0}
%S .mbs-Condensed:not(.mbs-Floating) .mbs-Field > .mb-Label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
%S .mbs-Condensed .mb-Input{border-radius:0}
%S .mbs-Condensed .mbs-Row2{margin-top:-1px}
%S .mbs-Condensed .mbs-Col2{margin-left:-1px}
%S .mbs-Condensed .mbs-tl .mb-Input{border-top-left-radius:var(--borderRadius)}
%S .mbs-Condensed .mbs-tr .mb-Input{border-top-right-radius:var(--borderRadius)}
%S .mbs-Condensed .mbs-bl .mb-Input{border-bottom-left-radius:var(--borderRadius)}
%S .mbs-Condensed .mbs-br .mb-Input{border-bottom-right-radius:var(--borderRadius)}
%S .mbs-Condensed .mbs-Field > .mb-Error{display:none}
%S .mbs-GroupError{display:none}
%S .mbs-Condensed .mbs-GroupError.mbs-shown{display:block}
@media (prefers-reduced-motion: reduce){%S *{transition:none !important;animation:none !important}}
`

/** Appearance API themes: variable defaults plus the rules that differ from `stripe`. */
export const THEMES: Record<string, { variables: Record<string, string>; css: string }> = {
  stripe: { variables: {}, css: "" },
  night: {
    variables: {
      colorPrimary: "#0085ff",
      colorBackground: "#30313d",
      colorText: "#ffffff",
      colorTextSecondary: "#a9a9b2",
      colorTextPlaceholder: "#86868f",
      colorDanger: "#fe87a1",
    },
    css: `
%S .mb-Input{box-shadow:0 1px 1px rgba(0,0,0,.3),0 3px 6px rgba(0,0,0,.2)}
%S .mb-Input:focus{box-shadow:0 1px 1px rgba(0,0,0,.3),0 3px 6px rgba(0,0,0,.2),var(--focusBoxShadow)}
%S .mb-Input--invalid{box-shadow:0 0 0 1px var(--colorDanger)}
`,
  },
  flat: {
    variables: { colorBackground: "#ffffff", borderRadius: "6px" },
    css: `
%S .mb-Label{font-weight:var(--fontWeightMedium);color:var(--colorTextSecondary)}
%S .mb-Input{border-color:transparent;box-shadow:none;background-color:color-mix(in srgb,var(--colorText) 5%,var(--colorBackground))}
%S .mb-Input:focus{border-color:var(--colorPrimary);background-color:var(--colorBackground);box-shadow:var(--focusBoxShadow)}
%S .mb-Input--invalid{border-color:var(--colorDanger);box-shadow:none}
%S .mb-Input--invalid:focus{box-shadow:0 0 0 3px color-mix(in srgb,var(--colorDanger) 25%,transparent)}
`,
  },
  none: {
    variables: { borderRadius: "0px", colorBorder: "#8a8a8a" },
    css: `
%S .mb-Input{box-shadow:none;transition:none}
%S .mb-Input:focus{box-shadow:none;outline:2px solid var(--colorPrimary);outline-offset:-1px}
%S .mb-Input--invalid,%S .mb-Input--invalid:focus{box-shadow:none}
`,
  },
}
