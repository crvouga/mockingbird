import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { Webhook } from "svix"
import { createRuntime, FLEX_PRESETS, type FlexRuntime } from "./src/index.js"
import {
  type Attempt,
  type AttemptStatus,
  type CatalogMapping,
  type CheckoutCommand,
  FlexApiClient,
  FlexApiError,
  FlexCatalog,
  FlexOrchestrator,
  FlexPaymentRepository,
  FlexWebhookReceiver,
  HttpException,
  payOnHostedPage,
  resolveStatus,
  validateProduct,
} from "./test/consumer.js"
import mappingsFixture from "./test/corpus/flex-catalog-mappings.json" with { type: "json" }

const params = fcParameters(process.env)
const API = "http://flex.mock"
const KEY = "fsk_test_mockingbird_acceptance"
/** `FLEX_WEBHOOK_SECRET`: Flex issues `fwhsec_<base64>`. */
const SECRET = `fwhsec_${Buffer.from("flex-mock-signing-key-0123456789").toString("base64")}`

const HSA = "4000 0512 3000 0072"
const REGULAR = "4242 4242 4242 4242"
const DECLINE = "4000 0000 0000 0002"

type Row = (typeof mappingsFixture.rows)[number]
const mappings = (): CatalogMapping[] =>
  mappingsFixture.rows.map((row: Row) => ({
    purpose: row.purpose as CatalogMapping["purpose"],
    merchantProductId: row.merchantProductId,
    flexProductId: row.flexProductId,
    eligibility: row.eligibility as CatalogMapping["eligibility"],
    visitType: row.visitType,
    active: row.active,
    metadata: row.metadata as Record<string, string>,
  }))

const MEMBERSHIP = "prod_SzwJThEUVC3ZZF" // membership, auto_substantiation, active
const SHOP = "prod_RPVGXPdPvh7eLt" // marketplace, auto_substantiation, active
const RX = "d3d857bb-6912-45fb-b772-c37ac797c7e2" // rx, prescription, active
const LMN_PRODUCT = "fprod_01m0w5y1eyhp3rtvt595xyga7e" // letter_of_medical_necessity, hairGrowth

type Delivery = { headers: Headers; body: string }

/**
 * A runtime whose webhooks land on our receiver (`POST /billing/webhooks/flex`), with our
 * consumer's client, catalog and orchestrator pointed at it.
 */
const harness = (options: { timeoutMs?: number; toleranceSeconds?: number } = {}) => {
  const deliveries: Delivery[] = []
  const responses: number[] = []
  let receiver: FlexWebhookReceiver | undefined
  const runtime: FlexRuntime = createRuntime({
    webhooks: {
      url: "http://backend.local/billing/webhooks/flex",
      secret: SECRET,
      fetch: async (request) => {
        const body = await request.text()
        deliveries.push({ headers: request.headers, body })
        const outcome = await (receiver as FlexWebhookReceiver).handle(request.headers, body)
        responses.push(outcome.status)
        return Response.json("body" in outcome ? outcome.body : { message: outcome.error }, {
          status: outcome.status,
        })
      },
    },
  })
  const api = new FlexApiClient({
    baseUrl: API,
    apiKey: KEY,
    fetch: (request) => runtime.fetch(request),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  const catalog = new FlexCatalog(mappings(), api)
  const repository = new FlexPaymentRepository()
  const orchestrator = new FlexOrchestrator(api, catalog, repository)
  receiver = new FlexWebhookReceiver(SECRET, orchestrator, options.toleranceSeconds)
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const settle = async () => {
    await runtime.webhooks.idle()
  }
  const attempt = (id: string) => repository.attempts.get(id) as Attempt
  return {
    runtime,
    api,
    catalog,
    repository,
    orchestrator,
    receiver,
    admin,
    deliveries,
    responses,
    settle,
    attempt,
  }
}

const command = (
  purpose: CheckoutCommand["purpose"],
  merchantProductId: string,
  amount: number,
  extra: Partial<CheckoutCommand> = {},
): CheckoutCommand => ({
  userId: 42,
  purpose,
  businessReference: `${purpose}-${merchantProductId}`,
  amountCents: amount,
  lineItems: [
    {
      merchantProductId,
      name: `Product ${merchantProductId}`,
      unitAmountCents: amount,
      quantity: 1,
    },
  ],
  successUrl: "https://app.gogeviti.com/shop/success?ref=x&session_id=%7BCHECKOUT_SESSION_ID%7D",
  cancelUrl: "https://app.gogeviti.com/shop/cancel?session={CHECKOUT_SESSION_ID}",
  metadata: { source: "acceptance" },
  ...extra,
})

describe("S4.10 acceptance: our consumer's logic against the mock", () => {
  for (const [flow, purpose, merchant, amount, setupFutureUse] of [
    ["membership", "membership", MEMBERSHIP, 19_900, "off_session"],
    ["shop", "marketplace", SHOP, 4_500, undefined],
    ["rx", "rx", RX, 12_000, undefined],
  ] as const) {
    test(`${flow}: create → hosted page (HSA card) → signed webhook → attempt succeeded, no reconciler`, async () => {
      const h = harness()
      const { attempt, result } = await h.orchestrator.createCheckout(
        command(purpose, merchant, amount, setupFutureUse ? { setupFutureUse } : {}),
      )
      expect(result.status).toBe("pending")
      // The hosted page is the mock's, never checkout.withflex.com.
      const page = new URL(result.redirectUrl)
      expect(page.origin).toBe(API)
      expect(page.pathname).toBe(`/pay/${result.providerReference}`)

      const paid = await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
      for (const id of ["email", "card", "exp", "cvc", "zip", "pay", "cancel"]) {
        expect(paid.page.markup).toContain(`data-testid="flex-mock-${id}"`)
      }
      expect(paid.response.status).toBe(302)
      // {CHECKOUT_SESSION_ID} is substituted in its %7B…%7D form.
      expect(paid.response.headers.get("location")).toBe(
        `https://app.gogeviti.com/shop/success?ref=x&session_id=${result.providerReference}`,
      )
      await h.settle()
      expect(h.responses.every((status) => status === 200)).toBe(true)
      const settled = h.attempt(attempt.id)
      expect(settled.status).toBe("succeeded")
      expect(settled.amountReceivedCents).toBe(amount)
      expect(settled.transitions).toEqual(["created", "processing", "pending", "succeeded"])
      if (setupFutureUse) {
        expect(settled.mandate?.status).toBe("active")
        expect(settled.providerCustomerId).toMatch(/^fcus_/)
        expect(settled.providerPaymentMethodId).toMatch(/^fpm_/)
      }
    })
  }

  test("the webhook reaches /billing/webhooks/flex and verifies with our verifier AND svix's own", async () => {
    const h = harness()
    const { result } = await h.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
    await h.settle()
    expect(h.deliveries.length).toBeGreaterThanOrEqual(2)
    // svix's Webhook takes the base64 key; Flex's fwhsec_ prefix is not svix's whsec_.
    const svix = new Webhook(SECRET.replace(/^fwhsec_/, ""))
    for (const delivery of h.deliveries) {
      const headers = Object.fromEntries(delivery.headers.entries())
      const verified = svix.verify(delivery.body, headers) as {
        event: { event_type: string; object: Record<string, unknown> }
      }
      expect(verified.event.object.checkout_session_id).toBe(result.providerReference)
    }
    for (const delivery of h.runtime.webhooks.deliveries()) {
      expect(new URL(delivery.url).pathname).toBe("/billing/webhooks/flex")
      expect(delivery.state).toBe("delivered")
    }
    expect(h.runtime.webhooks.deliveries().map((d) => d.type)).toEqual([
      "payment_intent.succeeded",
      "checkout.session.completed",
    ])
    // A tampered body or stale timestamp is refused the way our controller refuses it.
    const first = h.deliveries[0] as Delivery
    expect((await h.receiver.handle(first.headers, `${first.body} `)).status).toBe(401)
    const stale = new Headers(first.headers)
    stale.set("svix-timestamp", String(Math.floor(Date.now() / 1000) - 301))
    expect((await h.receiver.handle(stale, first.body)).status).toBe(401)
    const missing = new Headers(first.headers)
    missing.delete("svix-signature")
    expect((await h.receiver.handle(missing, first.body)).status).toBe(400)
  })

  test("a whsec_ secret signs the same scheme (svix's own prefix)", async () => {
    const secret = `whsec_${Buffer.from("another-signing-key-for-flex!!").toString("base64")}`
    const seen: Delivery[] = []
    const runtime = createRuntime({
      webhooks: {
        url: "http://backend.local/billing/webhooks/flex",
        secret,
        fetch: async (request) => {
          seen.push({ headers: request.headers, body: await request.text() })
          return new Response(null, { status: 200 })
        },
      },
    })
    await runtime.fetch(
      new Request(`${API}/__admin/products/${LMN_PRODUCT}`, {
        method: "PUT",
        body: JSON.stringify({ visit_type: "hairGrowth" }),
      }),
    )
    await runtime.webhooks.idle()
    const delivery = seen[0] as Delivery
    const verified = new Webhook(secret).verify(
      delivery.body,
      Object.fromEntries(delivery.headers.entries()),
    ) as {
      event: { event_type: string; object: { product_id: string } }
    }
    expect(verified.event.event_type).toBe("product.updated")
    expect(verified.event.object.product_id).toBe(LMN_PRODUCT)
    expect(() =>
      createRuntime({ webhooks: { url: "http://x/", secret: "not-a-flex-secret" } }),
    ).toThrow(TypeError)
  })

  test("an off-session renewal resolves succeeded in the create response", async () => {
    const h = harness()
    const first = await h.orchestrator.createCheckout(
      command("membership", MEMBERSHIP, 19_900, { setupFutureUse: "off_session" }),
    )
    await payOnHostedPage((r) => h.runtime.fetch(r), first.result.redirectUrl, HSA)
    await h.settle()
    const mandate = h.attempt(first.attempt.id)
    const deliveredBefore = h.deliveries.length
    const renewal = await h.orchestrator.createOffSessionCharge({
      ...command("membership", MEMBERSHIP, 19_900, { businessReference: "renewal-2026-10" }),
      providerCustomerId: mandate.providerCustomerId as string,
      providerPaymentMethodId: mandate.providerPaymentMethodId as string,
    })
    // flex-kill-bill-invoice.service.ts checks this immediately, with no webhook.
    expect(renewal.result.status).toBe("succeeded")
    expect(renewal.attempt.amountReceivedCents).toBe(19_900)
    await h.settle()
    expect(h.deliveries.length).toBeGreaterThan(deliveredBefore)

    // Declined renewals fail synchronously too.
    await h.admin("/settings", { offSessionOutcome: "declined" }, "PUT")
    const declined = await h.orchestrator
      .createOffSessionCharge({
        ...command("membership", MEMBERSHIP, 19_900, { businessReference: "renewal-2026-11" }),
        providerCustomerId: mandate.providerCustomerId as string,
        providerPaymentMethodId: mandate.providerPaymentMethodId as string,
      })
      .catch((error: unknown) => error)
    expect(declined).toBeInstanceOf(HttpException)
    const failed = [...h.repository.attempts.values()].find(
      (a) => a.businessReference === "renewal-2026-11",
    )
    expect(failed?.status).toBe("failed")
  })

  test("setup mode: customer create (idempotent) → setup session → card saved → succeeded with a mandate", async () => {
    const h = harness()
    const { attempt, result } = await h.orchestrator.createSetupCheckout({
      userId: 7,
      purpose: "membership",
      businessReference: "switch-7",
      successUrl:
        "geviti://settings?flexMembershipSwitch=success&flexSwitchSessionId={CHECKOUT_SESSION_ID}",
      cancelUrl: "geviti://settings?flexMembershipSwitch=cancel",
      customer: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: "6025550142",
      },
      metadata: { intent: "flex_membership_switch" },
    })
    expect(result.status).toBe("pending")
    const paid = await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
    expect(paid.response.headers.get("location")).toBe(
      `geviti://settings?flexMembershipSwitch=success&flexSwitchSessionId=${result.providerReference}`,
    )
    await h.settle()
    const settled = h.attempt(attempt.id)
    expect(settled.status).toBe("succeeded")
    expect(settled.providerPaymentId).toMatch(/^fseti_/)
    expect(settled.mandate?.status).toBe("active")
    // A missing phone never reaches Flex: profile-required.
    await expect(
      h.orchestrator.createSetupCheckout({
        userId: 8,
        purpose: "membership",
        businessReference: "switch-8",
        successUrl: "https://app.gogeviti.com/ok",
        cancelUrl: "https://app.gogeviti.com/no",
        customer: { firstName: "Ada", lastName: "L", email: "a@example.com", phone: null },
        metadata: {},
      }),
    ).rejects.toThrow(/phone/)
    // Setup mode without a customer is refused by our client before any request.
    await expect(
      h.api.createCheckoutSession(
        {
          clientReferenceId: "x",
          mode: "setup",
          lineItems: [],
          successUrl: "https://a/",
          cancelUrl: "https://b/",
          metadata: {},
        },
        "k",
      ),
    ).rejects.toThrow(/requires a customer/)
  })

  test("the attempt reaches succeeded within 2 s of paying, driven only by the webhook", async () => {
    const h = harness()
    const { attempt, result } = await h.orchestrator.createCheckout(command("rx", RX, 12_000))
    const started = performance.now()
    await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
    while (h.attempt(attempt.id).status !== "succeeded" && performance.now() - started < 2_000) {
      await Bun.sleep(5)
    }
    expect(h.attempt(attempt.id).status).toBe("succeeded")
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("S4.5: every state the orchestrator distinguishes is producible", () => {
  const openSession = async () => {
    const h = harness()
    const { attempt, result } = await h.orchestrator.createCheckout(
      command("marketplace", SHOP, 4_500),
    )
    return { h, attempt, id: result.providerReference }
  }
  const reconcile = async (h: ReturnType<typeof harness>, attemptId: string, id: string) =>
    (await h.orchestrator.reconcileAttempt(attemptId, id)).status

  test("each admin transition resolves to the status our resolveStatus maps it to", async () => {
    type Case = {
      name: string
      apply: (h: ReturnType<typeof harness>, id: string) => Promise<unknown>
      expected: AttemptStatus
    }
    const cases: Case[] = [
      { name: "open", apply: async () => {}, expected: "pending" },
      {
        name: "complete",
        apply: (h, id) => h.admin(`/sessions/${id}/complete`, {}),
        expected: "succeeded",
      },
      {
        name: "decline",
        apply: (h, id) => h.admin(`/sessions/${id}/decline`, {}),
        expected: "failed",
      },
      {
        name: "expire",
        apply: (h, id) => h.admin(`/sessions/${id}/expire`, {}),
        expected: "canceled",
      },
      ...(
        [
          "collect_letter_of_medical_necessity",
          "provide_second_payment_method",
          "provide_alternative_payment_method",
          "payment_failed",
        ] as const
      ).map(
        (type): Case => ({
          name: `require_action ${type}`,
          apply: (h, id) => h.admin(`/sessions/${id}/require_action`, { next_action_type: type }),
          expected: "action_required",
        }),
      ),
      ...(
        [
          ["requires_action", "action_required"],
          ["processing", "processing"],
          ["canceled", "canceled"],
          ["requires_payment_method", "failed"],
        ] as const
      ).map(
        ([status, expected]): Case => ({
          name: `payment intent ${status}`,
          apply: (h, id) => h.admin(`/sessions/${id}/payment-intent`, { status }, "PUT"),
          expected,
        }),
      ),
    ]
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...cases), async (item) => {
        const { h, attempt, id } = await openSession()
        await item.apply(h, id)
        expect(await reconcile(h, attempt.id, id)).toBe(item.expected)
      }),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })

  test("async payments: processing, then complete → async_payment_succeeded → succeeded", async () => {
    const { h, attempt, id } = await openSession()
    await h.admin(`/sessions/${id}/payment-intent`, { status: "processing" }, "PUT")
    expect(await reconcile(h, attempt.id, id)).toBe("processing")
    await h.admin(`/sessions/${id}/complete`, {})
    await h.settle()
    expect(h.receiver.received.map((r) => r.eventType)).toContain(
      "checkout.session.async_payment_succeeded",
    )
    expect(h.attempt(attempt.id).status).toBe("succeeded")
  })

  test("full refund → refunded; partial refund → quarantined; refund events all reconcile", async () => {
    const full = await openSession()
    await full.h.admin(`/sessions/${full.id}/complete`, {})
    await full.h.settle()
    const refunded = await full.h.orchestrator.refundAttempt(full.attempt.id)
    expect(refunded.status).toBe("refunded")
    await full.h.settle()
    expect(full.h.receiver.received.map((r) => r.eventType)).toEqual(
      expect.arrayContaining([
        "refund.created",
        "charge.refunded",
        "checkout.session.refunded",
        "refund.updated",
        "charge.refund.updated",
      ]),
    )
    // The refund idempotency key replays the stored response; our client sends it on retry.
    const again = await full.h.api.refundCheckoutSession(
      full.id,
      `flex-refund:${full.attempt.id}:full`,
    )
    expect(again.amount_refunded).toBe(4_500)

    const partial = await openSession()
    await partial.h.admin(`/sessions/${partial.id}/complete`, {})
    await partial.h.settle()
    const quarantined = await partial.h.orchestrator.refundAttempt(partial.attempt.id, 1_000)
    expect(quarantined.status).toBe("quarantined")
  })

  test("amount_mismatch quarantines as provider_amount_mismatch", async () => {
    const { h, attempt, id } = await openSession()
    await h.admin(`/sessions/${id}/complete`, {})
    h.runtime.applyPreset("amount_mismatch", "default", { count: 1 })
    expect(await reconcile(h, attempt.id, id)).toBe("quarantined")
    expect(h.attempt(attempt.id).errorCode).toBe("provider_amount_mismatch")
  })

  test("create faults: 4xx → failed; 5xx after create → adopted; duplicates → quarantined; timeout → adopted", async () => {
    const four = harness()
    four.runtime.applyPreset("create_4xx", "default", { count: 1 })
    const failed = await four.orchestrator
      .createCheckout(command("marketplace", SHOP, 4_500))
      .catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(FlexApiError)
    expect([...four.repository.attempts.values()][0]?.errorCode).toBe("flex_http_400")

    const five = harness()
    five.runtime.applyPreset("create_5xx", "default", { count: 1 })
    const adopted = await five.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    expect(adopted.result.status).toBe("pending")
    expect(adopted.result.providerReference).toMatch(/^fcs_/)

    const lost = harness()
    lost.runtime.applyPreset("create_5xx_not_created", "default", { count: 1 })
    const unknown = await lost.orchestrator
      .createCheckout(command("marketplace", SHOP, 4_500))
      .catch((e: unknown) => e)
    expect((unknown as FlexApiError).status).toBe(500)
    expect([...lost.repository.attempts.values()][0]?.status).toBe("processing")

    const dup = harness()
    dup.runtime.applyPreset("duplicate_sessions_for_client_reference", "default", { count: 1 })
    await expect(
      dup.orchestrator.createCheckout(command("marketplace", SHOP, 4_500)),
    ).rejects.toThrow(/manual reconciliation/)
    expect([...dup.repository.attempts.values()][0]?.errorCode).toBe("duplicate_provider_sessions")

    // The preset answers after 16 s, past the client's 15 s abort; here both are scaled down.
    expect(FLEX_PRESETS.timeout?.rules?.[0]?.params?.delayMs).toBeGreaterThan(15_000)
    const slow = harness({ timeoutMs: 100 })
    slow.runtime.applyPreset("timeout", "default", { count: 1, params: { delayMs: 400 } })
    const recovered = await slow.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    expect(recovered.result.status).toBe("pending")
  })

  test("invalid_shape: our zod validation rejects a session with neither redirect_url nor url", async () => {
    const { h, id } = await openSession()
    h.runtime.applyPreset("invalid_shape", "default", { count: 1 })
    const error = await h.api.getCheckoutSession(id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FlexApiError)
    expect((error as FlexApiError).message).toContain("missing its hosted checkout URL")
  })

  test("refund_4xx quarantines as flex_refund_http_400", async () => {
    const { h, attempt, id } = await openSession()
    await h.admin(`/sessions/${id}/complete`, {})
    await h.settle()
    h.runtime.applyPreset("refund_4xx", "default", { count: 1 })
    await expect(h.orchestrator.refundAttempt(attempt.id)).rejects.toBeInstanceOf(FlexApiError)
    expect(h.attempt(attempt.id).status).toBe("quarantined")
    expect(h.attempt(attempt.id).errorCode).toBe("flex_refund_http_400")
  })

  test("sessions expire on the mock clock and emit checkout.session.expired", async () => {
    const { h, attempt, id } = await openSession()
    h.runtime.clock.advance(24 * 3_600_000 + 1)
    await h.admin("/tick", {})
    await h.settle()
    expect(h.receiver.received.map((r) => r.eventType)).toContain("checkout.session.expired")
    expect(h.attempt(attempt.id).status).toBe("canceled")
    expect((await h.api.getCheckoutSession(id)).status).toBe("expired")
  })
})

describe("S4.6 hosted page", () => {
  test("4242 on a letter_of_medical_necessity product sets next_action=collect_letter_of_medical_necessity", async () => {
    const h = harness()
    const session = await h.api.createCheckoutSession(
      {
        clientReferenceId: "lmn-1",
        mode: "payment",
        lineItems: [{ flexProductId: LMN_PRODUCT, unitAmountCents: 9_900, quantity: 1 }],
        successUrl: "https://app.gogeviti.com/ok?s={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://app.gogeviti.com/no",
        metadata: {},
      },
      "lmn-key-1",
    )
    const paid = await payOnHostedPage((r) => h.runtime.fetch(r), session.redirect_url, REGULAR)
    expect(paid.response.status).toBe(302)
    const step = paid.response.headers.get("location") as string
    const waiting = await h.api.getCheckoutSession(session.checkout_session_id)
    expect(waiting.next_action?.type).toBe("collect_letter_of_medical_necessity")
    expect(waiting.next_action?.collect_letter_of_medical_necessity?.url).toBe(step)
    expect(resolveStatus(waiting, null)).toBe("action_required")
    // The next-action page, then its submit completes the payment.
    const page = await h.runtime.fetch(new Request(step))
    expect(await page.text()).toContain('data-testid="flex-mock-lmn-submit"')
    const done = await h.runtime.fetch(
      new Request(step, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "step=lmn",
      }),
    )
    expect(done.headers.get("location")).toBe(
      `https://app.gogeviti.com/ok?s=${session.checkout_session_id}`,
    )
    expect(resolveStatus(await h.api.getCheckoutSession(session.checkout_session_id), null)).toBe(
      "succeeded",
    )

    // The HSA card never asks for the letter.
    const second = await h.api.createCheckoutSession(
      {
        clientReferenceId: "lmn-2",
        mode: "payment",
        lineItems: [{ flexProductId: LMN_PRODUCT, unitAmountCents: 9_900, quantity: 1 }],
        successUrl: "https://app.gogeviti.com/ok",
        cancelUrl: "https://app.gogeviti.com/no",
        metadata: {},
      },
      "lmn-key-2",
    )
    await payOnHostedPage((r) => h.runtime.fetch(r), second.redirect_url, HSA)
    expect(resolveStatus(await h.api.getCheckoutSession(second.checkout_session_id), null)).toBe(
      "succeeded",
    )
  })

  test("4000 0000 0000 0002 declines on the page (role=alert) and the attempt fails", async () => {
    const h = harness()
    const { attempt, result } = await h.orchestrator.createCheckout(
      command("marketplace", SHOP, 4_500),
    )
    const paid = await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, DECLINE)
    expect(paid.response.status).toBe(402)
    expect(paid.body).toMatch(/<div role="alert"[^>]*>Your card was declined\.<\/div>/)
    await h.settle()
    expect(h.receiver.received.map((r) => r.eventType)).toEqual([
      "checkout.session.async_payment_failed",
    ])
    expect(h.attempt(attempt.id).status).toBe("failed")
  })

  test("cancel goes to cancel_url with {CHECKOUT_SESSION_ID} substituted raw; the session stays open", async () => {
    const h = harness()
    const { result } = await h.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    const cancel = await h.runtime.fetch(
      new Request(`${result.redirectUrl}/cancel`, { redirect: "manual" }),
    )
    expect(cancel.status).toBe(302)
    expect(cancel.headers.get("location")).toBe(
      `https://app.gogeviti.com/shop/cancel?session=${result.providerReference}`,
    )
    expect((await h.api.getCheckoutSession(result.providerReference)).status).toBe("open")
    const page = await h.runtime.fetch(new Request(result.redirectUrl))
    expect(await page.text()).toContain(`href="./${result.providerReference}/cancel"`)
  })

  test("a paid session's page is closed; an unknown session is 404; a bad card number is a 400 alert", async () => {
    const h = harness()
    const { result } = await h.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    const bad = await payOnHostedPage(
      (r) => h.runtime.fetch(r),
      result.redirectUrl,
      "4242 4242 4242 4241",
    )
    expect(bad.response.status).toBe(400)
    expect(bad.body).toContain("Your card number is invalid.")
    await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
    expect((await h.runtime.fetch(new Request(result.redirectUrl))).status).toBe(409)
    expect((await h.runtime.fetch(new Request(`${API}/pay/fcs_missing`))).status).toBe(404)
  })

  test("in a namespace, the hosted URL carries /ns/<name> (the browser sends no headers)", async () => {
    const h = harness()
    await h.admin("/credentials", { credentials: { fsk_test_worker_b: "b" } }, "PUT")
    const worker = new FlexApiClient({
      baseUrl: API,
      apiKey: "fsk_test_worker_b",
      fetch: (r) => h.runtime.fetch(r),
    })
    const session = await worker.createCheckoutSession(
      {
        clientReferenceId: "ns-1",
        mode: "payment",
        lineItems: [
          { flexProductId: "fprod_01m0tgysj4ahvf8fas60c2ef2d", unitAmountCents: 100, quantity: 1 },
        ],
        successUrl: "https://app.gogeviti.com/ok",
        cancelUrl: "https://app.gogeviti.com/no",
        metadata: {},
      },
      "ns-key",
    )
    expect(new URL(session.redirect_url).pathname).toBe(`/ns/b/pay/${session.checkout_session_id}`)
    const paid = await payOnHostedPage((r) => h.runtime.fetch(r), session.redirect_url, HSA)
    expect(paid.response.status).toBe(302)
    expect((await worker.getCheckoutSession(session.checkout_session_id)).status).toBe("complete")
    // The default namespace never saw it.
    await expect(h.api.getCheckoutSession(session.checkout_session_id)).rejects.toThrow(/404/)
  })
})

describe("S4.7 webhooks", () => {
  test("every listed event type (aliases included) is producible, enveloped and reconciled", async () => {
    const h = harness()
    const { attempt, result } = await h.orchestrator.createCheckout(
      command("marketplace", SHOP, 4_500),
    )
    const types = [
      "checkout.session.completed",
      "checkout_session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.refunded",
      "checkout.session.expired",
      "checkout_session.expired",
      "payment_intent.succeeded",
      "refund.created",
      "refund.updated",
      "charge.refunded",
      "charge.refund.updated",
    ]
    for (const type of types) {
      expect((await h.admin("/events", { type, session: result.providerReference })).status).toBe(
        201,
      )
    }
    expect(
      (await h.admin("/events", { type: "product.updated", product: LMN_PRODUCT })).status,
    ).toBe(201)
    await h.settle()
    // Deliveries run concurrently, so arrival order is not fixed; fan-out order is.
    expect(h.runtime.webhooks.deliveries().map((d) => d.type)).toEqual([
      ...types,
      "product.updated",
    ])
    expect(h.receiver.received.map((r) => r.eventType).sort()).toEqual(
      [...types, "product.updated"].sort(),
    )
    expect(h.receiver.received.every((r) => r.outcome === "processed")).toBe(true)
    const envelope = JSON.parse((h.deliveries[0] as Delivery).body) as {
      event: Record<string, unknown>
    }
    expect(Object.keys(envelope)).toEqual(["event"])
    expect(envelope.event).toMatchObject({
      event_id: expect.stringMatching(/^fevt_/),
      event_type: "checkout.session.completed",
      test_mode: true,
      object: { checkout_session_id: result.providerReference },
    })
    expect(typeof envelope.event.event_dt).toBe("number")
    expect(h.attempt(attempt.id).status).toBe("pending")
  })

  test("eventNaming=underscored sends the checkout_session.* aliases", async () => {
    const h = harness()
    await h.admin("/settings", { eventNaming: "underscored" }, "PUT")
    const { attempt, result } = await h.orchestrator.createCheckout(
      command("marketplace", SHOP, 4_500),
    )
    await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
    await h.settle()
    expect(h.receiver.received.map((r) => r.eventType)).toContain("checkout_session.completed")
    expect(h.attempt(attempt.id).status).toBe("succeeded")
  })

  test("webhook_duplicate is deduped per event_id; reorder and drop still converge through reconcile", async () => {
    const dup = harness()
    dup.runtime.applyPreset("webhook_duplicate", "default")
    const { attempt, result } = await dup.orchestrator.createCheckout(
      command("marketplace", SHOP, 4_500),
    )
    await payOnHostedPage((r) => dup.runtime.fetch(r), result.redirectUrl, HSA)
    await dup.settle()
    expect(dup.receiver.received.map((r) => r.outcome)).toContain("duplicate")
    expect(dup.attempt(attempt.id).status).toBe("succeeded")

    const reorder = harness()
    reorder.runtime.applyPreset("webhook_reorder", "default")
    const second = await reorder.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    await payOnHostedPage((r) => reorder.runtime.fetch(r), second.result.redirectUrl, HSA)
    await reorder.settle()
    expect(reorder.runtime.webhooks.deliveries().map((d) => d.type)).toEqual([
      "checkout.session.completed",
      "payment_intent.succeeded",
    ])
    expect(reorder.attempt(second.attempt.id).status).toBe("succeeded")

    const drop = harness()
    drop.runtime.applyPreset("webhook_drop", "default", { count: 2 })
    const third = await drop.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    await payOnHostedPage((r) => drop.runtime.fetch(r), third.result.redirectUrl, HSA)
    await drop.settle()
    expect(drop.receiver.received).toHaveLength(0)
    expect(drop.attempt(third.attempt.id).status).toBe("pending")
    // The return-leg refresh (or the reconciler) still converges.
    await drop.orchestrator.reconcileAttempt(third.attempt.id, third.result.providerReference)
    expect(drop.attempt(third.attempt.id).status).toBe("succeeded")
  })

  test("PUT /__admin/products/:id emits product.updated and our catalog refresh re-validates", async () => {
    const h = harness()
    const product = "fprod_01m0tgysj4ahvf8fas60c2ef2d" // the SHOP mapping
    const row = () => h.catalog.mappings.find((m) => m.flexProductId === product) as CatalogMapping
    expect(row().active).toBe(true)
    await h.admin(`/products/${product}`, { active: false }, "PUT")
    await h.settle()
    expect(row().active).toBe(false)
    await h.admin(`/products/${product}`, { active: true, hsa_fsa_eligibility: "vision" }, "PUT")
    await h.settle()
    expect(row()).toMatchObject({ active: true, eligibility: "vision" })
    await h.admin(`/products/${product}`, { test_mode: false }, "PUT")
    await h.settle()
    expect(row().active).toBe(false)
  })
})

describe("S4.3 auth, envelopes, idempotency", () => {
  test("fsk_test_ and fsk_ keys work (test_mode follows the key); other formats are 401", async () => {
    const h = harness()
    const live = new FlexApiClient({
      baseUrl: API,
      apiKey: "fsk_live_key_123",
      fetch: (r) => h.runtime.fetch(r),
    })
    expect(live.getExpectedTestMode()).toBe(false)
    const created = await live.createProduct({
      name: "Live product",
      description: "d",
      client_reference_id: "geviti:prod:marketplace:x",
      metadata: { geviti_purpose: "marketplace" },
    })
    expect(created.test_mode).toBe(false)
    expect(created.hsa_fsa_eligibility).toBeNull()
    for (const key of ["sk_test_stripe", "fsk", "Bearer", "whsec_abc"]) {
      const bad = new FlexApiClient({ baseUrl: API, apiKey: key, fetch: (r) => h.runtime.fetch(r) })
      const error = await bad.getProduct(LMN_PRODUCT).catch((e: unknown) => e)
      expect((error as FlexApiError).status).toBe(401)
    }
    expect(() =>
      new FlexApiClient({ baseUrl: API, apiKey: "sk_live_x", fetch: fetch }).getExpectedTestMode(),
    ).toThrow("Flex API key format is invalid")
    const none = await h.runtime.fetch(new Request(`${API}/v1/products/${LMN_PRODUCT}`))
    expect(none.status).toBe(401)
  })

  test("Idempotency-Key: same params replay, different params 400; on sessions, customers and refunds", async () => {
    const h = harness()
    const input = {
      clientReferenceId: "idem-1",
      mode: "payment" as const,
      lineItems: [{ flexProductId: LMN_PRODUCT, unitAmountCents: 100, quantity: 1 }],
      successUrl: "https://app.gogeviti.com/ok",
      cancelUrl: "https://app.gogeviti.com/no",
      metadata: {},
    }
    const a = await h.api.createCheckoutSession(input, "attempt-1")
    const b = await h.api.createCheckoutSession(input, "attempt-1")
    expect(b.checkout_session_id).toBe(a.checkout_session_id)
    const mismatch = await h.api
      .createCheckoutSession({ ...input, clientReferenceId: "idem-2" }, "attempt-1")
      .catch((e: unknown) => e)
    expect((mismatch as FlexApiError).status).toBe(400)
    expect((mismatch as FlexApiError).responseBody).toContain("idempotency_error")
    const profile = {
      firstName: "Ada",
      lastName: "L",
      email: "ada@example.com",
      phone: "6025550142",
    }
    const c1 = await h.api.createCustomer(profile, "flex-customer:abc")
    const c2 = await h.api.createCustomer(profile, "flex-customer:abc")
    expect(c2.customer_id).toBe(c1.customer_id)
    const c3 = await h.api.createCustomer(profile, "flex-customer:def")
    expect(c3.customer_id).not.toBe(c1.customer_id)
  })

  test("the journal records ids and never request bodies (card numbers, emails)", async () => {
    const h = harness()
    const { result } = await h.orchestrator.createCheckout(command("marketplace", SHOP, 4_500))
    await payOnHostedPage((r) => h.runtime.fetch(r), result.redirectUrl, HSA)
    const journal = await h.admin("/requests")
    const text = JSON.stringify(journal.body)
    expect(text).toContain(result.providerReference)
    expect(text).not.toContain("4000051230000072")
    expect(text).not.toContain("qa-flex-test")
  })
})

describe("S4.9 corpus", () => {
  test("every mapping resolves, and our catalog validation reproduces each mapping row", async () => {
    const h = harness()
    const products = await h.api.listProducts()
    expect(products.length).toBe(mappingsFixture.rows.length)
    const byId = new Map(products.map((p) => [p.product_id, p]))
    const expectedTestMode = h.api.getExpectedTestMode()
    for (const mapping of mappings()) {
      const product = byId.get(mapping.flexProductId)
      expect(product).toBeDefined()
      const validation = validateProduct(
        mapping,
        product as NonNullable<typeof product>,
        expectedTestMode,
        false,
      )
      expect({ id: mapping.flexProductId, active: validation.active }).toEqual({
        id: mapping.flexProductId,
        active: mapping.active,
      })
      expect(validation.eligibility).toBe(mapping.eligibility)
      expect(validation.visitType).toBe(mapping.visitType)
      // Active mappings pass even with the stricter configured-eligibility check.
      if (mapping.active)
        expect(validateProduct(mapping, product as never, expectedTestMode, true).reason).toBeNull()
    }
  })

  test("refreshProduct over every active mapping keeps it active (product.updated is a no-op on the corpus)", async () => {
    const h = harness()
    const active = h.catalog.mappings.filter((m) => m.active).slice(0, 25)
    for (const mapping of active) await h.catalog.refreshProduct(mapping.flexProductId)
    expect(active.every((m) => m.active)).toBe(true)
  })
})
