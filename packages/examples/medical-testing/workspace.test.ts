import { describe, expect, test } from "bun:test"
import { SESSION_HEADER, startSessionForProfile } from "./src/app/auth/session.js"
import type { AdminData, Order, User } from "./src/app/model.js"
import { buildDemo } from "./src/composition/build.js"

const setup = async () => {
  const demo = await buildDemo({ html: "", js: "" })
  const login = async (subject: string) => {
    const { token, user } = await startSessionForProfile(demo.db, {
      provider: "google",
      subject,
      email: null,
      name: null,
      picture: null,
    })
    return {
      user,
      request: (path: string, method = "GET", body?: unknown) =>
        demo.app.request(path, {
          method,
          headers: { [SESSION_HEADER]: token, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    }
  }
  return { demo, login }
}

describe("workspace permissions and records", () => {
  test("patient data stays private and staff access is enforced at HTTP routes", async () => {
    const { demo, login } = await setup()
    expect((await demo.app.request("/api/orders")).status).toBe(401)
    expect((await demo.app.request("/api/admin")).status).toBe(401)
    const patient = await login("ada")
    const stranger = await login("other-patient")
    const clinician = await login("clinician")
    const admin = await login("admin")
    expect(patient.user.role).toBe("patient")
    expect(stranger.user.role).toBe("patient")
    expect(clinician.user.role).toBe("clinician")
    expect(admin.user.role).toBe("admin")
    expect((await patient.request("/api/orders?scope=workspace")).status).toBe(403)
    expect((await patient.request("/api/admin")).status).toBe(403)
    expect((await clinician.request("/api/admin")).status).toBe(403)
    expect((await clinician.request("/api/orders?scope=workspace")).status).toBe(200)
    expect((await admin.request("/api/admin")).status).toBe(200)
    const { orders } = (await (await patient.request("/api/orders")).json()) as { orders: Order[] }
    expect(orders).toHaveLength(2)
    expect(orders.every((order) => order.userId === patient.user.id)).toBe(true)
    expect(
      ((await (await stranger.request("/api/orders")).json()) as { orders: Order[] }).orders,
    ).toHaveLength(0)
    const report = orders[0]
    if (!report) throw new Error("Expected a demo report")
    expect((await stranger.request(`/api/orders/${report.id}/files/results`)).status).toBe(404)
    expect(
      (
        await patient.request(`/api/orders/${report.id}/review`, "POST", {
          note: "Unauthorized review",
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await stranger.request("/api/checkout/hosted/start", "POST", {
          checkoutSessionId: report.checkoutSessionId,
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await stranger.request("/api/checkout/hosted/step", "POST", {
          flowId: "unknown",
          action: "",
          method: "POST",
          body: "",
        })
      ).status,
    ).toBe(404)
  })

  test("reviews, downloads, and role changes persist and leave truthful audit records", async () => {
    const { login } = await setup()
    const clinician = await login("clinician")
    const admin = await login("admin")
    const patient = await login("ada")
    const { orders } = (await (await patient.request("/api/orders")).json()) as { orders: Order[] }
    const report = orders.find((order) => !order.reviewedAt)
    if (!report) throw new Error("Expected an unreviewed report")
    expect(report.results.flatMap((panel) => panel.markers).length).toBe(12)
    expect(report.timeline.map((event) => event.status)).toEqual([
      "pending_payment",
      "fulfilled",
      "shipped",
      "processing",
      "results_ready",
    ])
    expect(
      (await clinician.request(`/api/orders/${report.id}/review`, "POST", { note: "x" })).status,
    ).toBe(400)
    expect(
      (
        await clinician.request(`/api/orders/${report.id}/review`, "POST", {
          note: "Synthetic report reviewed; follow-up recorded.",
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await clinician.request(`/api/orders/${report.id}/review`, "POST", {
          note: "Duplicate review",
        })
      ).status,
    ).toBe(409)
    const refreshed = (
      (await (await patient.request("/api/orders")).json()) as { orders: Order[] }
    ).orders.find((order) => order.id === report.id)
    expect(refreshed?.reviewer).toBe("Morgan Chen")
    expect(refreshed?.timeline.at(-1)?.status).toBe("reviewed")
    const csv = await patient.request(`/api/orders/${report.id}/files/results`)
    expect(csv.status).toBe(200)
    expect(csv.headers.get("content-disposition")).toContain(".csv")
    expect(await csv.text()).toContain('"LDL","132"')
    const receipt = await patient.request(`/api/orders/${report.id}/files/receipt`)
    expect(await receipt.text()).toContain("Total: $88.00")
    const record = await patient.request(`/api/orders/${report.id}/files/record`)
    expect(((await record.json()) as Order).reviewNote).toBe(
      "Synthetic report reviewed; follow-up recorded.",
    )
    expect(
      (await admin.request(`/api/admin/users/${admin.user.id}`, "PATCH", { role: "patient" }))
        .status,
    ).toBe(409)
    expect(
      (await admin.request(`/api/admin/users/${clinician.user.id}`, "PATCH", { role: "owner" }))
        .status,
    ).toBe(400)
    expect(
      (await admin.request(`/api/admin/users/${clinician.user.id}`, "PATCH", { role: "patient" }))
        .status,
    ).toBe(200)
    expect((await clinician.request("/api/orders?scope=workspace")).status).toBe(403)
    const data = (await (await admin.request("/api/admin")).json()) as AdminData
    expect(data.audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "Reviewed results",
        "Downloaded results",
        "Downloaded receipt",
        "Downloaded record",
        "Changed role from clinician to patient",
      ]),
    )
  })

  test("profile preferences persist, invalid orders are rejected, unpaid files stay unavailable", async () => {
    const { login } = await setup()
    const patient = await login("ada")
    expect(
      (await patient.request("/api/auth/profile", "PATCH", { name: " ", notifications: true }))
        .status,
    ).toBe(400)
    expect(
      (
        await patient.request("/api/auth/profile", "PATCH", {
          name: "Demo Patient",
          notifications: false,
          role: "admin",
        })
      ).status,
    ).toBe(200)
    const { user } = (await (await patient.request("/api/auth/me")).json()) as { user: User }
    expect(user.name).toBe("Demo Patient")
    expect(user.notifications).toBe(false)
    expect(user.role).toBe("patient")
    expect((await patient.request("/api/checkout", "POST", { testIds: "invalid" })).status).toBe(
      400,
    )
    expect(
      (await patient.request("/api/checkout", "POST", { testIds: [crypto.randomUUID()] })).status,
    ).toBe(400)
    const { tests } = (await (await patient.request("/api/tests")).json()) as {
      tests: { id: string }[]
    }
    const created = await patient.request("/api/checkout", "POST", {
      testIds: [tests[0]?.id, tests[0]?.id],
    })
    expect(created.status).toBe(200)
    const { orderId } = (await created.json()) as { orderId: string }
    expect((await patient.request(`/api/orders/${orderId}/files/results`)).status).toBe(409)
    expect((await patient.request(`/api/orders/${orderId}/files/receipt`)).status).toBe(409)
    const order = (
      (await (await patient.request("/api/orders")).json()) as { orders: Order[] }
    ).orders.find((order) => order.id === orderId)
    expect(order?.items).toHaveLength(1)
  })
})
