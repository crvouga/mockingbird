import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { CHECKOUT } from "../../src/lib/quick-start.ts"

// Use Node's loader: Vite's config module runner is closed when pages load.
// biome-ignore lint/suspicious/noExplicitAny: this executes the public, build-verified snippets.
const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<any>

/** Executes the exact three displayed modules against the built emulators. */
export async function verifyCheckout(serviceDir: string): Promise<void> {
  const modules = new Map<string, string>()
  const nonce = crypto.randomUUID()
  // The snippets import the vendor SDK by name; use the copy the Stripe emulator is tested against.
  const sdk = pathToFileURL(
    createRequire(join(serviceDir, CHECKOUT.sdk, "package.json")).resolve(CHECKOUT.sdk),
  ).href
  for (const step of CHECKOUT.steps) {
    let code = step.code as string
    for (const pkg of CHECKOUT.packages) {
      const name = pkg.replace("@crvouga/mockingbird-service-", "")
      code = code.replaceAll(
        JSON.stringify(pkg),
        JSON.stringify(pathToFileURL(join(serviceDir, name, "dist/index.js")).href),
      )
    }
    code = code.replaceAll(JSON.stringify(CHECKOUT.sdk), JSON.stringify(sdk))
    for (const [file, url] of modules) {
      code = code.replaceAll(JSON.stringify(`./${file}`), JSON.stringify(url))
    }
    const source = transpileModule(`const console = { log() {} };\n${code}\n// ${nonce}`, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
    }).outputText
    modules.set(step.file, `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  }
  const moduleUrl = (file: string) => {
    const url = modules.get(file)
    if (!url) throw new Error(`Quick start module missing: ${file}`)
    return url
  }
  const data = await nativeImport(moduleUrl("data.ts"))
  try {
    const server = await nativeImport(moduleUrl("api.ts"))
    const { stripe } = server
    const { order, response } = await nativeImport(moduleUrl("client.ts"))
    const [saved] = data.db.query("SELECT * FROM orders")
    if (
      response.status !== 201 ||
      !order.orderId ||
      order.paymentStatus !== "succeeded" ||
      saved?.id !== order.orderId
    ) {
      throw new Error("checkout did not persist a successfully paid order")
    }
    const intent = await stripe.paymentIntents.retrieve(saved.payment_id)
    if (intent.amount !== 2900 || intent.status !== "succeeded") {
      throw new Error("checkout payment does not match the product price")
    }
    const missing = await server.api.fetch(
      new Request("http://app.local/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: "missing" }),
      }),
    )
    if (missing.status !== 404 || data.db.query("SELECT * FROM orders").length !== 1) {
      throw new Error("missing products must not create an order")
    }
  } finally {
    data.db.close()
  }
}
