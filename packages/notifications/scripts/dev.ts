/**
 * Local demo: boot a fleet with every messaging emulator, serve the harness against it, and send
 * a realistic burst of SMS, WhatsApp, email, push and chat so there is something to look at.
 *
 *   bun run --cwd packages/notifications dev            # harness on http://127.0.0.1:8790
 *   bun run --cwd packages/notifications dev --quiet    # no sample traffic
 */
import { createInstalledServiceLoader, startFleet } from "@crvouga/mockingbird-adapter-node"
import { createServer } from "../src/server.js"
import * as send from "../test/send.js"

const quiet = process.argv.includes("--quiet")
const port = Number(process.env.PORT ?? 8790)
const services = [
  "twilio",
  "resend",
  "fcm",
  "ses",
  "sns",
  "customerio",
  "mailosaur",
  "slack",
] as const

const fleet = await startFleet(
  { log: "off", services: Object.fromEntries(services.map((s) => [s, { port: 0 }])) } as never,
  {
    load: createInstalledServiceLoader({
      projectRoot: `${import.meta.dir}/..`,
      services: [...services],
    }),
  },
)
const harness = await createServer({ fleet: fleet.manifest.adminBase, port })
const target = (name: string): send.Target => ({
  url: (fleet.manifest.services[name] as { url: string }).url.replace(/\/$/, ""),
  fetch: (request) => fetch(request),
})

console.log(`Notifications harness   ${harness.url}`)
console.log(`Fleet controller        ${fleet.manifest.adminBase}`)
for (const name of services) console.log(`  ${name.padEnd(12)} ${target(name).url}`)

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

if (!quiet) {
  const phone = "+12025550123"
  await send.fcmRegister(target("fcm"), "ios-7f3a9c2e1b", "ios")
  await send.twilioSms(target("twilio"), {
    to: phone,
    from: "+18885550100",
    body: "Acme: Your order #1042 has been confirmed. Track it at https://acme.example/t/1042",
  })
  await send.resendEmail(target("resend"), {
    from: "Acme <orders@acme.example>",
    to: ["ada@example.com"],
    subject: "Your Acme order #1042 is confirmed",
    html: `<div style="max-width:560px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;color:#1f2937">
      <div style="padding:24px 0;border-bottom:1px solid #e5e7eb"><b style="font-size:20px;color:#4f46e5">acme</b></div>
      <h1 style="font-size:22px;margin:24px 0 8px">Thanks for your order, Ada!</h1>
      <p style="color:#4b5563;line-height:1.6">We're getting order <b>#1042</b> ready. You'll get another email when it ships.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
        <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Trail running shoes × 1</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">$118.00</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Merino socks × 2</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">$24.00</td></tr>
        <tr><td style="padding:10px 0"><b>Total</b></td><td style="text-align:right"><b>$142.00</b></td></tr></table>
      <a href="https://acme.example/orders/1042" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">View your order</a>
      <p style="color:#9ca3af;font-size:12px;margin-top:32px">Acme Outdoor Co. · 1 Example Way · Springfield</p></div>`,
  })
  await pause(400)
  await send.fcmPush(target("fcm"), {
    token: "ios-7f3a9c2e1b",
    notification: {
      title: "Order confirmed",
      body: "Your trail running shoes are being packed. We'll let you know when they ship.",
    },
    data: { orderId: "1042", deepLink: "acme://orders/1042" },
    apns: { payload: { aps: { badge: 1, sound: "default" } } },
  })
  await send.fcmPush(target("fcm"), {
    token: "fixture-device-token",
    notification: {
      title: "Flash sale ends tonight",
      body: "Take 20% off rain jackets until midnight.",
    },
    android: { notification: { image: "https://picsum.photos/seed/mockingbird/600/300" } },
  })
  await send.twilioVerify(target("twilio"), phone)
  await send.sesEmail(target("ses"))
  await send.sesRawEmail(target("ses"))
  await pause(400)
  await send.snsSms(
    target("sns"),
    "+12025550177",
    "Your Acme sign-in code is 482913. It expires in 10 minutes.",
  )
  await send.snsTopicFanout(target("sns"))
  await send.customerioSend(target("customerio"), "email", {
    transactional_message_id: "welcome",
    identifiers: { email: "lin@example.com" },
    to: "lin@example.com",
    from: "Acme Team <team@acme.example>",
    subject: "Welcome to Acme, Lin",
    message_data: { first_name: "Lin", plan: "Trail Club" },
  })
  await send.customerioSend(target("customerio"), "sms", {
    transactional_message_id: "1",
    identifiers: { id: "42" },
    to: phone,
    from: "+18885550100",
    message_data: { body: "Acme: Your order #1042 shipped! Arriving Tuesday." },
  })
  await send.mailosaurIngest(target("mailosaur"), {
    to: "qa@acme.mailosaur.net",
    from: "Acme Security <security@acme.example>",
    subject: "Reset your password",
    html: "<p>Someone asked to reset your password.</p><p><a href='https://acme.example/reset?token=9f2'>Reset password</a></p>",
  })
  await send.twilioWhatsApp(target("twilio"), {
    to: phone,
    body: "Hi Ada, your Acme order #1042 is out for delivery. Reply STOP to opt out.",
  })
  await send.twilioVerify(target("twilio"), phone, "default", "whatsapp")
  await send.slackPost(target("slack"), {
    channel: "#alerts",
    text: "Order #1042 shipped",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Order #1042 shipped" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Trail running shoes* left the warehouse :package:" },
        fields: [
          { type: "mrkdwn", text: "*Carrier*\nExample Post" },
          { type: "mrkdwn", text: "*Arrives*\nTuesday" },
        ],
      },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "View order" } },
          { type: "button", text: { type: "plain_text", text: "Snooze" } },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Sent by the fulfilment worker" }] },
    ],
  })
  await send.slackPost(target("slack"), {
    channel: "#general",
    text: "Deploy `web@4f2c1a9` finished in *3m 12s*. <https://acme.example/deploys/918|View the deploy>",
  })
  await send.slackWebhook(target("slack"), {
    text: "Checkout error rate is above 2%",
    attachments: [
      {
        color: "danger",
        title: "checkout-api",
        text: "5xx responses: 2.4% over the last 5 minutes",
        fields: [
          { title: "Region", value: "us-east-1", short: true },
          { title: "Since", value: "14:02", short: true },
        ],
        footer: "Example Monitoring",
      },
    ],
  })
  console.log("Sent sample SMS, WhatsApp, email, push and chat. Open the harness URL above.")
}

const stop = async () => {
  await harness.close()
  await fleet.close()
  process.exit(0)
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
