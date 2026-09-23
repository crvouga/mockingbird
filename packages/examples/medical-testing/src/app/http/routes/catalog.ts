import { Hono } from "hono"
import { listLabTests } from "../../db/labTestsRepo.js"
import type { AppEnv } from "../appEnv.js"

export const catalogRoutes = new Hono<AppEnv>()

catalogRoutes.get("/tests", async (c) => {
  const tests = (await listLabTests(c.get("db"))).map((test) => ({
    id: test.id,
    name: test.name,
    description: test.description,
    category: test.category,
    priceCents: test.price_cents,
  }))
  return c.json({ tests })
})
