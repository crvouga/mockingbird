/**
 * A merchant's payment page using the Stripe.js stand-in (`GET /v3`): the stand-in's script is
 * inlined, Elements are created with the story's options, and Pay confirms against the
 * emulator. Shared by the Payment Element, card Element and split card Element stories.
 */
import type { StoryObj } from "@storybook/html-vite"
import { stripeJs } from "../../../../../packages/service/stripe/src/stripe-js.js"
import { frame } from "../../../src/frame.js"
import { ORIGIN, PUBLISHABLE_KEY, stripe } from "./stripe.js"

export type Shop = {
  /** Page background and text colour around the Element (a dark theme needs a dark page). */
  dark?: boolean
  /** Markup for the Element containers, inside the form. */
  slots: string
  /** CSS the merchant ships, e.g. for `.StripeElement`. */
  css?: string
  /** Script run after `stripe` and `clientSecret` exist: create and mount Elements, define `pay`. */
  script: string
}

const json = (value: unknown) => JSON.stringify(value ?? null)

/** The merchant page around the Elements. */
export const shop = (
  { dark, slots, css = "", script }: Shop,
  clientSecret: string,
) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Complete your payment</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:start center;padding:40px 16px;
  font:16px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  background:${dark ? "#14151c" : "#f4f5f7"};color:${dark ? "#f1f1f3" : "#1a1a1a"}}
.card{width:100%;max-width:520px;padding:32px;border-radius:20px;background:${dark ? "#1e1f29" : "#fff"};
  box-shadow:0 10px 30px rgba(0,0,0,${dark ? ".4" : ".06"})}
h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
.price{margin:0 0 24px;color:${dark ? "#a9a9b2" : "#6d6e78"}}
.slots{display:grid;gap:12px}
button{margin-top:24px;width:100%;height:48px;border:0;border-radius:999px;background:#3a64e4;color:#fff;
  font-family:inherit;font-weight:600;font-size:16px;cursor:pointer}
button[disabled]{opacity:.6;cursor:progress}
.message{margin:16px 0 0;font-size:14px;min-height:21px}
.message.ok{color:#1ea672}.message.error{color:#df1b41}
${css}
</style></head>
<body><main class="card">
<h1>Complete your payment</h1><p class="price">Unlimited · $7.00 per month</p>
<form id="checkout" data-testid="shop-form"><div class="slots">${slots}</div>
<button type="submit" id="submit" data-testid="shop-pay">Pay $7.00</button>
<p class="message" id="message" role="status" data-testid="shop-message"></p></form>
</main>
<script>${stripeJs(ORIGIN)}</script>
<script>
var stripe = Stripe(${json(PUBLISHABLE_KEY)});
var clientSecret = ${json(clientSecret)};
var message = document.getElementById("message");
var submit = document.getElementById("submit");
function report(result) {
  submit.disabled = false;
  if (result.error) { message.className = "message error"; message.textContent = result.error.message; return; }
  var intent = result.paymentIntent || result.setupIntent;
  message.className = "message ok";
  message.textContent = "Payment " + intent.status + " — " + intent.id;
}
${script}
document.getElementById("checkout").addEventListener("submit", function (event) {
  event.preventDefault();
  submit.disabled = true;
  message.textContent = "";
  pay().then(report);
});
</script></body></html>`

/** A PaymentIntent for $7.00 on a fresh emulator, whose client secret the page confirms. */
async function intent() {
  const s = stripe()
  const created = await s.post("/v1/payment_intents", {
    amount: 700,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
  })
  return { emulator: s.emulator, clientSecret: created.client_secret ?? "" }
}

/** A story drawing `shop(page(args))` on a fresh PaymentIntent. */
export function shopStory<Args extends Record<string, unknown>>(
  build: (args: Args) => Shop,
): StoryObj<Args> {
  return {
    loaders: [async () => intent()],
    render: (args, context) => {
      const { emulator, clientSecret } = context.loaded as Awaited<ReturnType<typeof intent>>
      return frame(shop(build(args), clientSecret), { url: `${ORIGIN}/shop`, emulator })
    },
  }
}
