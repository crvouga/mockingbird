import { Hono } from "hono"
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
  const orders = await listOrders(c.get("db"), user.id)
  return c.json({ orders })
})
