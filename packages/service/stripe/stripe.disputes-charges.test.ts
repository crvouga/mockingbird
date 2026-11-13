import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Responding to disputes (evidence, submit, close, admin-driven outcomes), updating charges, and
 * the credit-note routes the emulator declares but does not model, driven through stripe-node.
 */

const KEY = "sk_test_disputesSuite1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({
    accounts: [{ id: "acct_disputes", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const events = async (type: string) =>
    (await stripe.events.list({ type, limit: 100 })).data.map((event) => event.data)
  const raw = async (method: string, path: string, body?: string) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      ...(body === undefined ? {} : { body }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return { server, stripe, admin, events, raw }
}

type Harness = Awaited<ReturnType<typeof harness>>

const charge = async ({ stripe }: Harness, card = "pm_card_visa", amount = 5_000) => {
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    payment_method: card,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  })
  return stripe.charges.retrieve(intent.latest_charge as string)
}

const disputed = async (h: Harness, amount = 5_000) => {
  const paid = await charge(h, "pm_card_createDispute", amount)
  const list = await h.stripe.disputes.list({ charge: paid.id })
  const dispute = list.data[0]
  if (!dispute) throw new Error("expected a dispute")
  return { charge: paid, dispute }
}

const expectStripeError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

describe("dispute object", () => {
  test("a dispute carries evidence, evidence_details with a due_by, balance_transactions and is_charge_refundable", async () => {
    const h = await harness()
    const { dispute } = await disputed(h, 5_000)
    expect(dispute.evidence_details.due_by).toBeGreaterThan(dispute.created)
    expect(dispute.evidence_details).toMatchObject({
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    })
    expect(dispute.evidence.product_description).toBeNull()
    expect(dispute.evidence.uncategorized_text).toBeNull()
    expect(dispute.is_charge_refundable).toBe(false)
    expect(dispute.payment_method_details).toMatchObject({
      type: "card",
      card: { brand: "visa", network: "visa", case_type: "chargeback" },
    })
    expect(dispute.balance_transactions).toHaveLength(1)
    const withdrawal = dispute.balance_transactions[0]
    expect(withdrawal).toMatchObject({
      object: "balance_transaction",
      amount: -5_000,
      fee: 1_500,
      net: -6_500,
      type: "adjustment",
      reporting_category: "dispute",
      source: dispute.id,
    })
    const ledger = await h.stripe.balanceTransactions.retrieve(withdrawal?.id as string)
    expect(ledger.net).toBe(-6_500)
    expect((await h.events("charge.dispute.funds_withdrawn")).length).toBe(1)
  })

  test("an inquiry (warning_needs_response) withdraws no funds and leaves the charge refundable", async () => {
    const h = await harness()
    const paid = await charge(h)
    const opened = await h.admin("POST", "/disputes", {
      charge: paid.id,
      status: "warning_needs_response",
    })
    expect(opened.status).toBe(201)
    const dispute = await h.stripe.disputes.retrieve(opened.body.id as string)
    expect(dispute.balance_transactions).toEqual([])
    expect(dispute.is_charge_refundable).toBe(true)
    expect(dispute.payment_method_details?.card?.case_type).toBe("inquiry")
  })
})

describe("disputes.update", () => {
  test("submit=false stages evidence without submitting it, emitting charge.dispute.updated", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    const staged = await h.stripe.disputes.update(dispute.id, {
      evidence: { product_description: "Monthly membership", customer_name: "Jane Doe" },
      submit: false,
    })
    expect(staged.status).toBe("needs_response")
    expect(staged.evidence.product_description).toBe("Monthly membership")
    expect(staged.evidence.customer_name).toBe("Jane Doe")
    expect(staged.evidence_details).toMatchObject({ has_evidence: true, submission_count: 0 })
    const updated = await h.events("charge.dispute.updated")
    expect(updated).toHaveLength(1)
    expect((updated[0]?.object as Stripe.Dispute | undefined)?.evidence.product_description).toBe(
      "Monthly membership",
    )
    expect(updated[0]?.previous_attributes).toHaveProperty("evidence")
  })

  test("evidence is submitted by default: the dispute moves to under_review and submission_count counts it", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    await h.stripe.disputes.update(dispute.id, {
      evidence: { customer_name: "Jane Doe" },
      submit: false,
    })
    const submitted = await h.stripe.disputes.update(dispute.id, {
      evidence: { uncategorized_text: "Customer used the service all month" },
    })
    expect(submitted.status).toBe("under_review")
    // Evidence merges: the staged field survives the second update.
    expect(submitted.evidence.customer_name).toBe("Jane Doe")
    expect(submitted.evidence.uncategorized_text).toBe("Customer used the service all month")
    expect(submitted.evidence_details).toMatchObject({
      has_evidence: true,
      past_due: false,
      submission_count: 1,
    })
    const updated = await h.events("charge.dispute.updated")
    expect(updated[0]?.previous_attributes).toMatchObject({ status: "needs_response" })
  })

  test("submit=true alone submits the staged evidence", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    await h.stripe.disputes.update(dispute.id, {
      evidence: { customer_name: "Jane Doe" },
      submit: false,
    })
    const submitted = await h.stripe.disputes.update(dispute.id, { submit: true })
    expect(submitted.status).toBe("under_review")
    expect(submitted.evidence_details.submission_count).toBe(1)
  })

  test("metadata merges without submitting evidence", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    await h.stripe.disputes.update(dispute.id, { metadata: { case: "A-1", owner: "ops" } })
    const updated = await h.stripe.disputes.update(dispute.id, { metadata: { owner: "" } })
    expect(updated.metadata).toEqual({ case: "A-1" })
    expect(updated.status).toBe("needs_response")
    expect(updated.evidence_details.submission_count).toBe(0)
  })

  test("evidence is refused once it has been submitted", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    await h.stripe.disputes.update(dispute.id, { evidence: { customer_name: "Jane Doe" } })
    const error = await expectStripeError(
      h.stripe.disputes.update(dispute.id, { evidence: { customer_name: "John Doe" } }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.type).toBe("StripeInvalidRequestError")
    expect((await h.stripe.disputes.retrieve(dispute.id)).evidence.customer_name).toBe("Jane Doe")
  })

  test("enhanced evidence is refused explicitly rather than ignored", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    const error = await expectStripeError(
      h.stripe.disputes.update(dispute.id, {
        evidence: { enhanced_evidence: { visa_compliance: { fee_acknowledged: true } } },
      }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("evidence[enhanced_evidence]")
    expect(error.message).toContain("not modelled")
    const after = await h.stripe.disputes.retrieve(dispute.id)
    expect(after.status).toBe("needs_response")
    expect(after.evidence_details.has_evidence).toBe(false)
  })

  test("an unknown dispute is resource_missing", async () => {
    const h = await harness()
    const error = await expectStripeError(h.stripe.disputes.update("dp_missing", { metadata: {} }))
    expect(error.statusCode).toBe(404)
    expect(error.code).toBe("resource_missing")
  })
})

describe("disputes.close", () => {
  test("closing accepts the dispute as lost and emits charge.dispute.closed", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    const closed = await h.stripe.disputes.close(dispute.id)
    expect(closed.status).toBe("lost")
    const events = await h.events("charge.dispute.closed")
    expect(events).toHaveLength(1)
    expect((events[0]?.object as Stripe.Dispute | undefined)?.status).toBe("lost")
    expect(events[0]?.previous_attributes).toMatchObject({ status: "needs_response" })
    // The withdrawal stands: no reinstatement.
    expect(closed.balance_transactions).toHaveLength(1)
  })

  test("closing an inquiry leaves it warning_closed", async () => {
    const h = await harness()
    const paid = await charge(h)
    const opened = await h.admin("POST", "/disputes", {
      charge: paid.id,
      status: "warning_needs_response",
    })
    const closed = await h.stripe.disputes.close(opened.body.id as string)
    expect(closed.status).toBe("warning_closed")
  })

  test("a closed dispute can be neither closed again nor updated with evidence", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    await h.stripe.disputes.close(dispute.id)
    const again = await expectStripeError(h.stripe.disputes.close(dispute.id))
    expect(again.statusCode).toBe(400)
    const evidence = await expectStripeError(
      h.stripe.disputes.update(dispute.id, { evidence: { customer_name: "Jane Doe" } }),
    )
    expect(evidence.statusCode).toBe(400)
    expect((await h.events("charge.dispute.closed")).length).toBe(1)
  })
})

describe("PUT /__admin/disputes/:id", () => {
  test("winning a dispute reinstates the funds and emits charge.dispute.closed", async () => {
    const h = await harness()
    const { dispute } = await disputed(h, 4_000)
    await h.stripe.disputes.update(dispute.id, { evidence: { customer_name: "Jane Doe" } })
    const moved = await h.admin("PUT", `/disputes/${dispute.id}`, { status: "won" })
    expect(moved.status).toBe(200)
    expect(moved.body.status).toBe("won")
    const won = await h.stripe.disputes.retrieve(dispute.id)
    expect(won.status).toBe("won")
    expect(won.balance_transactions).toHaveLength(2)
    expect(won.balance_transactions[1]).toMatchObject({
      amount: 4_000,
      type: "adjustment",
      reporting_category: "dispute_reversal",
    })
    const closed = await h.events("charge.dispute.closed")
    expect(closed).toHaveLength(1)
    expect(closed[0]?.previous_attributes).toMatchObject({ status: "under_review" })
    expect((await h.events("charge.dispute.funds_reinstated")).length).toBe(1)
  })

  test("a non-terminal move emits charge.dispute.updated", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    const moved = await h.admin("PUT", `/disputes/${dispute.id}`, { status: "under_review" })
    expect(moved.status).toBe(200)
    const updated = await h.events("charge.dispute.updated")
    expect(updated).toHaveLength(1)
    expect(updated[0]?.previous_attributes).toEqual({ status: "needs_response" })
  })

  test("an unknown status is a 400 and an unknown dispute a 404", async () => {
    const h = await harness()
    const { dispute } = await disputed(h)
    expect((await h.admin("PUT", `/disputes/${dispute.id}`, { status: "pending" })).status).toBe(
      400,
    )
    expect((await h.admin("PUT", "/disputes/dp_missing", { status: "won" })).status).toBe(404)
    expect((await h.stripe.disputes.retrieve(dispute.id)).status).toBe("needs_response")
  })
})

describe("charges.update", () => {
  test("description and metadata update the charge and emit charge.updated", async () => {
    const h = await harness()
    const paid = await charge(h)
    await h.stripe.charges.update(paid.id, { metadata: { order: "1001", source: "web" } })
    const updated = await h.stripe.charges.update(paid.id, {
      description: "Order 1001",
      metadata: { source: "" },
    })
    expect(updated.description).toBe("Order 1001")
    expect(updated.metadata).toEqual({ order: "1001" })
    const retrieved = await h.stripe.charges.retrieve(paid.id)
    expect(retrieved.description).toBe("Order 1001")
    const events = await h.events("charge.updated")
    expect(events).toHaveLength(2)
    // Newest first.
    expect(events[0]?.previous_attributes).toEqual({
      description: null,
      metadata: { source: "web" },
    })
  })

  test("receipt_email is stored and a customer can be set on a charge that has none", async () => {
    const h = await harness()
    const paid = await charge(h)
    expect(paid.customer).toBeNull()
    const customer = await h.stripe.customers.create({ email: "jane@example.com" })
    const updated = await h.stripe.charges.update(paid.id, {
      receipt_email: "jane@example.com",
      customer: customer.id,
    })
    expect(updated.receipt_email).toBe("jane@example.com")
    expect(updated.customer).toBe(customer.id)
    const other = await h.stripe.customers.create({ email: "john@example.com" })
    const error = await expectStripeError(h.stripe.charges.update(paid.id, { customer: other.id }))
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("customer")
    expect((await h.stripe.charges.retrieve(paid.id)).customer).toBe(customer.id)
  })

  test("an unknown customer is resource_missing", async () => {
    const h = await harness()
    const paid = await charge(h)
    const error = await expectStripeError(
      h.stripe.charges.update(paid.id, { customer: "cus_missing" }),
    )
    expect(error.code).toBe("resource_missing")
    expect(error.param).toBe("customer")
  })

  for (const [param, body] of [
    ["fraud_details", { fraud_details: { user_report: "fraudulent" } }],
    ["shipping", { shipping: { name: "Jane", address: { line1: "1 Main St" } } }],
    ["transfer_group", { transfer_group: "order_1001" }],
  ] as const)
    test(`${param} is refused explicitly and the charge is left unchanged`, async () => {
      const h = await harness()
      const paid = await charge(h)
      const error = await expectStripeError(
        h.stripe.charges.update(paid.id, {
          description: "should not stick",
          ...(body as Stripe.ChargeUpdateParams),
        }),
      )
      expect(error.statusCode).toBe(400)
      expect(error.param).toBe(param)
      expect(error.message).toContain("not modelled")
      expect((await h.stripe.charges.retrieve(paid.id)).description).toBeNull()
      expect(await h.events("charge.updated")).toHaveLength(0)
    })
})

describe("credit notes", () => {
  test("credit-note operations answer an explicit unsupported error", async () => {
    const h = await harness()
    const calls: Array<[string, string, string?]> = [
      ["POST", "/v1/credit_notes", "invoice=in_123"],
      ["GET", "/v1/credit_notes"],
      ["GET", "/v1/credit_notes/cn_123"],
      ["POST", "/v1/credit_notes/cn_123/void", ""],
      ["GET", "/v1/credit_notes/preview?invoice=in_123"],
    ]
    for (const [method, path, body] of calls) {
      const response = await h.raw(method, path, body)
      expect(response.status).toBe(400)
      const error = response.body.error as Record<string, unknown>
      expect(error.type).toBe("invalid_request_error")
      expect(error.code).toBe("mockingbird_unsupported")
      expect(String(error.message)).toContain("credit notes are not modelled")
    }
    const error = await expectStripeError(h.stripe.creditNotes.list())
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe("mockingbird_unsupported")
  })
})
