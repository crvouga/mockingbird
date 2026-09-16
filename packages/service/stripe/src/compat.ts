import { Collection, IdSequence, jsonResponse } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

type RecordValue = Record<string, unknown>

type Resource = {
  collection: Collection<RecordValue>
  prefix: string
  object: string
}

const parseForm = async (request: Request) => {
  const text = await request.text()
  const params = new URLSearchParams(text)
  const out: RecordValue = {}
  for (const [key, value] of params) {
    if (key.endsWith("[]")) {
      const name = key.slice(0, -2)
      const current = out[name]
      out[name] = Array.isArray(current) ? [...current, value] : [value]
      continue
    }
    const match = /^(.*)\[(\d+)\]\[(.*)\]$/.exec(key)
    if (match) {
      const parent = match[1]
      const index = match[2]
      const child = match[3]
      if (parent === undefined || index === undefined || child === undefined) continue
      const list = (out[parent] as RecordValue[] | undefined) ?? []
      out[parent] = list
      const item = list[Number(index)] ?? {}
      list[Number(index)] = item
      item[child] = value
      continue
    }
    const nested = /^(.*)\[(.*)\]$/.exec(key)
    if (nested) {
      const parent = nested[1]
      const child = nested[2]
      if (parent === undefined || child === undefined) continue
      const object = (out[parent] as RecordValue | undefined) ?? {}
      out[parent] = object
      object[child] = value
      continue
    }
    out[key] = value
  }
  return out
}

const number = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const page = (data: RecordValue[], url: string) => ({
  object: "list",
  data,
  has_more: false,
  url,
})

export class StripeCompatibility {
  private readonly ids: IdSequence
  constructor(
    private readonly sqlite: SqliteClient,
    private readonly namespace: string,
  ) {
    this.ids = new IdSequence(sqlite, namespace, "compat")
  }

  private resource(path: string): Resource | undefined {
    const resources: Record<string, [string, string, string]> = {
      payment_methods: ["pm_", "payment_method", "payment_methods"],
      payment_intents: ["pi_", "payment_intent", "payment_intents"],
      setup_intents: ["seti_", "setup_intent", "setup_intents"],
      charges: ["ch_", "charge", "charges"],
      refunds: ["re_", "refund", "refunds"],
      subscriptions: ["sub_", "subscription", "subscriptions"],
      invoices: ["in_", "invoice", "invoices"],
      invoiceitems: ["ii_", "invoiceitem", "invoiceitems"],
      coupons: ["coupon_", "coupon", "coupons"],
      promotion_codes: ["promo_", "promotion_code", "promotion_codes"],
      webhook_endpoints: ["we_", "webhook_endpoint", "webhook_endpoints"],
      subscription_schedules: ["sub_sched_", "subscription_schedule", "subscription_schedules"],
      checkout_sessions: ["cs_", "checkout.session", "checkout_sessions"],
    }
    const entry = resources[path]
    if (!entry) return undefined
    const prefix = entry[0]
    const object = entry[1]
    const collection = entry[2]
    return { prefix, object, collection: new Collection(this.sqlite, this.namespace, collection) }
  }

  private async id(prefix: string) {
    return this.ids.next(prefix)
  }

  private base(resource: Resource, id: string, params: RecordValue, now: number): RecordValue {
    return {
      id,
      object: resource.object,
      created: Math.floor(now / 1000),
      livemode: false,
      metadata: params.metadata ?? {},
    }
  }

  private async create(resource: Resource, params: RecordValue, now: number) {
    const id = await this.id(resource.prefix)
    const value = this.base(resource, id, params, now)
    if (resource.object === "payment_method") {
      Object.assign(value, {
        type: params.type ?? "card",
        customer: params.customer ?? null,
        billing_details: params.billing_details ?? {},
        card: { brand: "visa", checks: {}, country: "US", funding: "credit", last4: "4242" },
      })
    } else if (resource.object === "payment_intent") {
      Object.assign(value, {
        amount: number(params.amount),
        amount_received: number(params.amount),
        currency: params.currency ?? "usd",
        customer: params.customer ?? null,
        description: params.description ?? null,
        payment_method: params.payment_method ?? null,
        payment_method_types: ["card"],
        status: params.payment_method ? "succeeded" : "requires_payment_method",
        client_secret: `${id}_secret_mockingbird`,
        charges: {
          object: "list",
          data: [],
          has_more: false,
          url: `/v1/charges?payment_intent=${id}`,
        },
      })
    } else if (resource.object === "setup_intent") {
      Object.assign(value, {
        customer: params.customer ?? null,
        payment_method: params.payment_method ?? null,
        payment_method_types: ["card"],
        status: params.payment_method ? "succeeded" : "requires_payment_method",
        usage: params.usage ?? "off_session",
        client_secret: `${id}_secret_mockingbird`,
      })
    } else if (resource.object === "charge") {
      Object.assign(value, {
        amount: number(params.amount),
        amount_refunded: 0,
        currency: params.currency ?? "usd",
        customer: params.customer ?? null,
        payment_intent: params.payment_intent ?? null,
        paid: true,
        status: "succeeded",
        refunded: false,
      })
    } else if (resource.object === "refund") {
      Object.assign(value, {
        amount: number(params.amount),
        currency: params.currency ?? "usd",
        payment_intent: params.payment_intent ?? null,
        charge: params.charge ?? null,
        status: "succeeded",
      })
    } else if (resource.object === "subscription") {
      const items = Array.isArray(params.items)
        ? params.items
        : [{ price: params["items[0][price]"] }]
      Object.assign(value, {
        customer: params.customer,
        status: "active",
        cancel_at_period_end: false,
        current_period_start: Math.floor(now / 1000),
        current_period_end: Math.floor(now / 1000) + 2592000,
        items: {
          object: "list",
          data: items.map((item: RecordValue) => ({
            id: `si_${id.slice(4)}`,
            object: "subscription_item",
            price: { id: item.price },
            quantity: number(item.quantity, 1),
          })),
          has_more: false,
          url: `/v1/subscription_items?subscription=${id}`,
        },
        latest_invoice: null,
      })
    } else if (resource.object === "invoice") {
      Object.assign(value, {
        customer: params.customer,
        status: "draft",
        paid: false,
        amount_due: 0,
        amount_paid: 0,
        currency: params.currency ?? "usd",
        subscription: params.subscription ?? null,
        lines: page([], `/v1/invoices/${id}/lines`),
      })
    } else if (resource.object === "invoiceitem") {
      Object.assign(value, {
        customer: params.customer,
        invoice: params.invoice ?? null,
        amount: number(params.amount),
        currency: params.currency ?? "usd",
        description: params.description ?? null,
      })
    } else if (resource.object === "coupon") {
      Object.assign(value, {
        name: params.name ?? null,
        percent_off: params.percent_off ? number(params.percent_off) : null,
        amount_off: params.amount_off ? number(params.amount_off) : null,
        currency: params.currency ?? null,
        valid: true,
      })
    } else if (resource.object === "promotion_code") {
      Object.assign(value, {
        code: params.code,
        active: true,
        customer: params.customer ?? null,
        coupon: params.coupon ?? null,
        restrictions: {},
      })
    } else if (resource.object === "checkout.session") {
      Object.assign(value, {
        mode: params.mode ?? "payment",
        status: "open",
        payment_status: "unpaid",
        customer: params.customer ?? null,
        payment_intent: null,
        subscription: null,
        url: `https://checkout.stripe.com/c/pay/${id}`,
      })
    } else if (resource.object === "webhook_endpoint") {
      Object.assign(value, {
        url: params.url,
        enabled_events: params.enabled_events ?? ["*"],
        status: "enabled",
        secret: `whsec_${id.slice(3)}`,
      })
    } else if (resource.object === "subscription_schedule") {
      Object.assign(value, {
        customer: params.customer,
        status: "active",
        subscription: null,
        phases: params.phases ?? [],
      })
    }
    resource.collection.insert(id, value)
    if (resource.object === "payment_intent") {
      const charges = this.resource("charges")
      if (charges) {
        const charge = await this.create(
          charges,
          {
            amount: value.amount,
            currency: value.currency,
            customer: value.customer,
            payment_intent: id,
          },
          now,
        )
        value.latest_charge = charge.id
        const chargesValue = value.charges
        value.charges = {
          ...(chargesValue && typeof chargesValue === "object" ? chargesValue : {}),
          data: [charge],
        }
        resource.collection.update(id, value)
      }
    }
    return value
  }

  private async update(resource: Resource, id: string, params: RecordValue, now: number) {
    const current = resource.collection.get(id)
    if (!current) return undefined
    const next = {
      ...current,
      ...params,
      metadata:
        params.metadata && typeof params.metadata === "object"
          ? {
              ...(current.metadata && typeof current.metadata === "object" ? current.metadata : {}),
              ...params.metadata,
            }
          : current.metadata,
      updated: Math.floor(now / 1000),
    }
    resource.collection.update(id, next)
    return next
  }

  async fetch(request: Request, now = Date.now()): Promise<Response> {
    const url = new URL(request.url)
    const segments = url.pathname.split("/").filter(Boolean)
    if (segments[0] !== "v1") return new Response("", { status: 404 })
    const path = segments.slice(1).join("/")
    const action = segments.at(-1) ?? ""
    if (path === "customers/search" && request.method === "GET") {
      const query = url.searchParams.get("query") ?? ""
      const email = /email:\s*'([^']+)'/.exec(query)?.[1]
      const customers = new Collection<RecordValue>(this.sqlite, this.namespace, "customers")
        .list({ order: "oldest" })
        .map((row) => row.value)
        .filter((entry) => entry.kind === "live")
        .map((entry) => entry.customer as RecordValue)
        .filter((customer) => !email || customer.email === email)
      return jsonResponse(200, page(customers, "/v1/customers/search"))
    }
    if (segments[1] === "customers" && segments[3] === "balance_transactions") {
      const id = segments[2] ?? ""
      if (request.method === "POST") {
        const params = await parseForm(request)
        const customers = new Collection<RecordValue>(this.sqlite, this.namespace, "customers")
        const entry = customers.get(id)
        const customer = entry?.kind === "live" ? (entry.customer as RecordValue) : undefined
        if (!customer)
          return jsonResponse(404, {
            error: {
              type: "invalid_request_error",
              code: "resource_missing",
              message: `No such customer: '${id}'`,
            },
          })
        const next = { ...customer, balance: number(customer.balance) + number(params.amount) }
        customers.update(id, { kind: "live", customer: next })
        return jsonResponse(200, {
          id: await this.id("cbtxn_"),
          object: "customer_balance_transaction",
          amount: number(params.amount),
          currency: params.currency ?? "usd",
          ending_balance: next.balance,
          customer: id,
          created: Math.floor(now / 1000),
        })
      }
      return jsonResponse(200, page([], `/v1/customers/${id}/balance_transactions`))
    }
    if (segments[1] === "checkout" && segments[2] === "sessions" && segments[4] === "line_items")
      return jsonResponse(200, page([], `/v1/checkout/sessions/${segments[3]}/line_items`))
    if (segments[1] === "invoices" && segments[2] === "upcoming") {
      const params =
        request.method === "POST" ? await parseForm(request) : Object.fromEntries(url.searchParams)
      return jsonResponse(200, {
        id: `upcoming_in_${Math.floor(now / 1000)}`,
        object: "invoice",
        customer: params.customer ?? null,
        status: "draft",
        paid: false,
        amount_due: 0,
        amount_paid: 0,
        currency: params.currency ?? "usd",
        lines: page([], "/v1/invoices/upcoming/lines"),
      })
    }
    if (segments[1] === "invoices" && segments[3] === "lines")
      return jsonResponse(200, page([], `/v1/invoices/${segments[2]}/lines`))
    const resourcePath =
      segments[1] === "checkout" && segments[2] === "sessions" ? "checkout_sessions" : segments[1]
    const resource = this.resource(resourcePath ?? "")
    if (!resource) return new Response("", { status: 404 })
    const id = resourcePath === "checkout_sessions" ? segments[2] : segments[2]
    if (request.method === "POST" && !id)
      return jsonResponse(200, await this.create(resource, await parseForm(request), now))
    if (request.method === "GET" && !id) {
      const params = url.searchParams
      const rows = resource.collection
        .list({ order: "newest" })
        .map((row) => row.value)
        .filter((item) => !params.get("customer") || item.customer === params.get("customer"))
        .filter((item) => !params.get("product") || item.product === params.get("product"))
        .filter((item) => !params.get("code") || item.code === params.get("code"))
        .filter(
          (item) =>
            !params.get("payment_intent") || item.payment_intent === params.get("payment_intent"),
        )
      return jsonResponse(
        200,
        page(rows.slice(0, number(params.get("limit"), 10)), `/${segments.join("/")}`),
      )
    }
    if (!id)
      return jsonResponse(404, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "Missing resource id",
        },
      })
    let current = resource.collection.get(id)
    if (!current && resource.object === "payment_method" && action === "attach") {
      const created = await this.create(resource, { type: "card" }, now)
      resource.collection.delete(created.id as string)
      current = { ...created, id }
      resource.collection.insert(id, current)
    }
    if (!current)
      return jsonResponse(404, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: `No such ${resource.object}: '${id}'`,
        },
      })
    if (request.method === "GET") return jsonResponse(200, current)
    if (request.method === "DELETE") {
      resource.collection.delete(id)
      return jsonResponse(200, { ...current, deleted: true })
    }
    if (request.method === "POST" || request.method === "PATCH") {
      const params = await parseForm(request)
      if (action === "cancel" || action === "void" || action === "expire" || action === "release")
        params.status =
          action === "cancel"
            ? "canceled"
            : action === "void"
              ? "void"
              : action === "expire"
                ? "expired"
                : "released"
      if (resource.object === "setup_intent" && action === "confirm") params.status = "succeeded"
      if (resource.object === "payment_intent" && action === "capture") {
        params.status = "succeeded"
        params.amount_received = current.amount
      }
      if (resource.object === "payment_method" && action === "detach") {
        resource.collection.update(id, { ...current, customer: null })
        return jsonResponse(200, { ...current, customer: null })
      }
      if (resource.object === "invoice" && action === "pay")
        Object.assign(params, { status: "paid", paid: true, amount_paid: current.amount_due })
      if (resource.object === "checkout.session" && action === "complete")
        Object.assign(params, { status: "complete", payment_status: "paid" })
      return jsonResponse(200, await this.update(resource, id, params, now))
    }
    return new Response("", { status: 405 })
  }
}
