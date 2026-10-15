import { afterEach, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

const KEY = "sk_test_emptyExpand1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

// Live parity: Stripe validates `expand=` before it looks the subscription item up.
test("retrieving a subscription item with an empty expand is refused before the lookup", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/subscription_items/si_missing?expand=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("expand")
})

// Live parity: on a search, Stripe refuses an empty `query` before an empty `expand`.
test("a search with empty query and empty expand names the query", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee2", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/payment_intents/search?query=&expand=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("query")
})

// Live parity: an out-of-range limit is refused before an empty `expand`.
test("a search with limit 0 and empty expand names the limit", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee3", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/payment_intents/search?query=a&limit=0&expand=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_integer")
  expect(error.param).toBe("limit")
})

// Live parity: an empty customer_account on the schedules list is refused before the filters.
test("listing schedules with an empty customer_account and a bad released_at names customer_account", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee4", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(
    `${server.url}/v1/subscription_schedules?customer_account=&released_at=`,
    { headers: { authorization: `Bearer ${KEY}` } },
  )
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("customer_account")
})

// Live parity: a bad enum value on a POST is reported before an empty `expand`.
test("a POST with an invalid tax_exempt and empty expand names tax_exempt", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee5", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/customers/cus_missing`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ expand: "", tax_exempt: " " }),
  })
  const { error } = (await response.json()) as { error: { param: string } }
  expect(response.status).toBe(400)
  expect(error.param).toBe("tax_exempt")
})

// Live parity: filtering invoice items by a customer that does not exist is a 400, not an empty list.
test("listing invoice items for a missing customer is refused", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee6", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/invoiceitems?customer=cus_missing`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("resource_missing")
  expect(error.param).toBe("customer")
})

// Live parity: creating a price with an empty metadata is refused before the product lookup.
test("creating a price with empty metadata for a missing product names metadata", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee7", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/prices`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ currency: "usd", metadata: "", product: "prod_missing" }),
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("metadata")
})

// Live parity: Stripe calls a missing event a "notification", as its list cursors already do.
test("retrieving a missing event says no such notification", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee8", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/events/evt_missing`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { message: string } }
  expect(response.status).toBe(404)
  expect(error.message).toStartWith("No such notification: 'evt_missing'")
})

// Live parity: the scheduled/timestamp conflict is reported before an empty customer_account.
test("listing schedules with scheduled and released_at names the conflict first", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee9", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(
    `${server.url}/v1/subscription_schedules?scheduled=false&released_at=5&customer_account=`,
    { headers: { authorization: `Bearer ${KEY}` } },
  )
  const { error } = (await response.json()) as { error: { message: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.param).toBe("released_at")
  expect(error.message).toBe(
    "You may only specify one of these parameters: released_at, scheduled.",
  )
})

// Live parity: an empty invoice filter on a customer's balance transactions is refused.
test("listing balance transactions with an empty invoice names invoice", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee10", keys: [KEY] }] })
  closers.push(() => server.close())
  const headers = { authorization: `Bearer ${KEY}` }
  const customer = (await (
    await fetch(`${server.url}/v1/customers`, { method: "POST", headers })
  ).json()) as { id: string }
  const response = await fetch(
    `${server.url}/v1/customers/${customer.id}/balance_transactions?invoice=`,
    { headers },
  )
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("invoice")
})

// Live parity: listing subscriptions with an empty `price` is refused, not treated as unset.
test("listing subscriptions with an empty price is refused", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee5", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/subscriptions?price=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("price")
})

test("listing subscriptions rejects an empty customer account while allowing omission", async () => {
  const server = await createServer({
    accounts: [{ id: "acct_empty_customer_account", keys: [KEY] }],
  })
  closers.push(() => server.close())
  const headers = { authorization: `Bearer ${KEY}` }
  const response = await fetch(`${server.url}/v1/subscriptions?created=0&customer_account=`, {
    headers,
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      code: "parameter_invalid_empty",
      param: "customer_account",
    },
  })
  const omitted = await fetch(`${server.url}/v1/subscriptions?created=0`, { headers })
  expect(omitted.status).toBe(200)
  expect(await omitted.json()).toMatchObject({ object: "list", data: [] })
})

// Live parity: an empty custom-field name is refused before a malformed email.
test("creating a customer with a bad email and an empty custom-field name names the field", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee6", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/customers`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "email=%20&invoice_settings[custom_fields][0][name]=&invoice_settings[custom_fields][0][value]=",
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("invoice_settings[custom_fields][0][name]")
})

// Live Stripe seed 1057600108: list cursors are validated before the invoice filter.
test("listing balance transactions validates an empty cursor before an empty invoice", async () => {
  const server = await createServer({ accounts: [{ id: "acct_cursor_order", keys: [KEY] }] })
  closers.push(() => server.close())
  const headers = { authorization: `Bearer ${KEY}` }
  const customer = (await (
    await fetch(`${server.url}/v1/customers`, { method: "POST", headers })
  ).json()) as { id: string }
  const response = await fetch(
    `${server.url}/v1/customers/${customer.id}/balance_transactions?ending_before=&invoice=`,
    { headers },
  )
  const { error } = (await response.json()) as {
    error: { code: string; param: string; message: string }
  }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("ending_before")
  expect(error.message).toBe(
    "You passed an empty string for 'ending_before'. We assume empty values are an attempt to unset a parameter; however 'ending_before' cannot be unset. You should remove 'ending_before' from your request or supply a non-empty value.",
  )
})
