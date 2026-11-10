import { Hono } from "hono"
import { appendOrderEvent, audit, findOrderById } from "../../db/ordersRepo.js"
import { can } from "../../model.js"
import { notifyReviewRecorded } from "../../notifications/patientNotifications.js"
import { listOrders } from "../../orders/listOrders.js"
import type { AppEnv } from "../appEnv.js"

export const ordersRoutes = new Hono<AppEnv>()
ordersRoutes.use("*", async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Sign in required" }, 401)
  return next()
})
ordersRoutes.get("/", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  const workspace = c.req.query("scope") === "workspace"
  if (workspace && !can(user.role, "orders.read"))
    return c.json({ error: "You do not have permission to view workspace orders." }, 403)
  return c.json({ orders: await listOrders(c.get("db"), workspace ? undefined : user.id) })
})
ordersRoutes.post("/:id/review", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  if (!can(user.role, "results.review"))
    return c.json({ error: "Clinical review requires a clinician or administrator." }, 403)
  const { note } = await c.req.json<{ note?: unknown }>()
  if (typeof note !== "string" || note.trim().length < 5 || note.length > 2000)
    return c.json({ error: "Enter a review note of 5–2,000 characters." }, 400)
  const db = c.get("db")
  const order = (await listOrders(db)).find((order) => order.id === c.req.param("id"))
  if (!order) return c.json({ error: "Order not found." }, 404)
  if (order.status !== "results_ready" || order.reviewedAt)
    return c.json({ error: "Only unreviewed, completed reports can be reviewed." }, 409)
  const actor = user.name ?? "Clinician"
  await db.query(
    "UPDATE orders SET reviewed_at = $2, review_note = $3, reviewer = $4 WHERE id = $1",
    [order.id, new Date().toISOString(), note.trim(), actor],
  )
  await appendOrderEvent(db, order.id, "reviewed", note.trim(), actor)
  await audit(db, actor, "Reviewed results", order.id)
  const row = await findOrderById(db, order.id)
  if (row) await notifyReviewRecorded(db, c.get("notifier"), row, actor)
  return c.json({ ok: true })
})

const csvCell = (value: unknown): string => {
  const text = String(value ?? "")
  // Prevent spreadsheet formulas in exported free-text fields.
  return `"${(/^[=+@-]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`
}
ordersRoutes.get("/:id/files/:kind", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  const order = (
    await listOrders(c.get("db"), can(user.role, "orders.read") ? undefined : user.id)
  ).find((order) => order.id === c.req.param("id"))
  if (!order) return c.json({ error: "Order not found." }, 404)
  const kind = c.req.param("kind")
  if (!["results", "receipt", "record"].includes(kind))
    return c.json({ error: "Unknown file." }, 404)
  if (kind === "results" && order.status !== "results_ready")
    return c.json({ error: "Results are not available yet." }, 409)
  if (kind === "receipt" && order.status === "pending_payment")
    return c.json({ error: "A receipt is available after payment." }, 409)
  let text: string
  if (kind === "results") {
    text = [
      [
        "Panel",
        "Biomarker",
        "Value",
        "Unit",
        "Reference low",
        "Reference high",
        "Flag",
        "Previous (synthetic)",
      ],
      ...order.results.flatMap((panel) =>
        panel.markers.map((marker) => [
          panel.panel,
          marker.name,
          marker.value,
          marker.unit,
          marker.low,
          marker.high,
          marker.flag,
          marker.previous,
        ]),
      ),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  } else if (kind === "receipt") {
    text = `LAB TESTING — PAYMENT RECEIPT\nOrder: ${order.id}\nPatient: ${order.patientName}\nPlaced: ${order.createdAt}\n\n${order.items.map((item) => `${item.testName}  $${(item.priceCents / 100).toFixed(2)}`).join("\n")}\n\nTotal: $${(order.items.reduce((sum, item) => sum + item.priceCents, 0) / 100).toFixed(2)}\n\nDemonstration payment. No real charge.\n`
  } else
    text = JSON.stringify(
      { ...order, notice: "Fictional demonstration data. Not for clinical use." },
      null,
      2,
    )
  await audit(c.get("db"), user.name ?? "User", `Downloaded ${kind}`, order.id)
  const extension = kind === "results" ? "csv" : kind === "record" ? "json" : "txt"
  return c.body(text, 200, {
    "content-type":
      kind === "results"
        ? "text/csv; charset=utf-8"
        : kind === "record"
          ? "application/json"
          : "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="lab-${order.id}-${kind}.${extension}"`,
    "cache-control": "no-store",
  })
})
