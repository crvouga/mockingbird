/** These three modules are highlighted and executed together during the docs build. */
export const CHECKOUT = {
  packages: ["@crvouga/mockingbird-service-postgres", "@crvouga/mockingbird-service-stripe"],
  /** The vendor SDK the API calls, exactly as the application would. Not a Mockingbird package. */
  sdk: "stripe",
  steps: [
    {
      id: "data",
      title: "Data",
      file: "data.ts",
      description: "Seed a product catalog and an orders table in the PostgreSQL emulator.",
      code: `import { Database } from "@crvouga/mockingbird-service-postgres"

export const db = new Database()

db.exec(\`
  CREATE TABLE products (id text PRIMARY KEY, name text, price integer);
  CREATE TABLE orders (id text PRIMARY KEY, product_id text, payment_id text);

  INSERT INTO products VALUES ('starter-kit', 'Developer starter kit', 2900);
\`)

// Real SQL, in memory. No database server to configure.
console.log(db.query("SELECT name, price FROM products"))
// [{ name: "Developer starter kit", price: 2900 }]`,
    },
    {
      id: "api",
      title: "API",
      file: "api.ts",
      description:
        "Read a product, charge it with the Stripe SDK, and persist the order. The emulator answers the SDK in this process.",
      code: `import Stripe from "stripe"
import { createRuntime } from "@crvouga/mockingbird-service-stripe"
import { db } from "./data.ts"

// The Stripe SDK your application already uses. Only its HTTP client changes:
// requests reach the emulator in this process instead of api.stripe.com.
const emulator = createRuntime()
export const stripe = new Stripe("sk_test_mockingbird", {
  httpClient: Stripe.createFetchHttpClient((url: string, init: RequestInit) =>
    emulator.fetch(new Request(url, init)),
  ),
})

export const api = {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/orders") {
      return Response.json({ error: "Not found" }, { status: 404 })
    }
    const { productId } = await request.json()
    const [product] = db.query<{ price: number }>(
      "SELECT price FROM products WHERE id = $1", [productId],
    )
    if (!product) return Response.json({ error: "Product not found" }, { status: 404 })

    const intent = await stripe.paymentIntents.create({
      amount: product.price, currency: "usd",
      payment_method: "pm_card_visa", confirm: true,
    })
    if (intent.status !== "succeeded") {
      return Response.json({ paymentStatus: intent.status }, { status: 402 })
    }

    const orderId = crypto.randomUUID()
    db.prepare("INSERT INTO orders VALUES ($1, $2, $3)").run(orderId, productId, intent.id)
    return Response.json({ orderId, paymentStatus: intent.status }, { status: 201 })
  },
}`,
    },
    {
      id: "client",
      title: "Client",
      file: "client.ts",
      description:
        "Place an order through the application's Fetch handler. The whole flow stays local.",
      code: `import { api } from "./api.ts"

// The same Request / Response interface your client already uses.
export const response = await api.fetch(new Request("http://app.local/orders", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ productId: "starter-kit" }),
}))

export const order = await response.json()
console.log(response.status)       // 201
console.log(order.paymentStatus)   // "succeeded"

// Product read → payment confirmed → order saved.
// PostgreSQL + Stripe + your API, without a single network request.`,
    },
  ],
} as const
