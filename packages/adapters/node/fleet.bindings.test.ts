import { expect, test } from "bun:test"
import { sealArchive } from "./src/fleet-archive.js"
import { planRestoreBindings } from "./src/fleet-bindings.js"

test("restore binding plans are immutable, explicit, redacted and validate signing and secret references (#405)", async () => {
  const source = sealArchive({ format: "mockingbird.fleet/v1", sourceId: "synthetic", createdAt: new Date(0).toISOString(), namespaces: { alpha: { clock: { now: 0, frozen: true }, services: { fixture: { protocol: "http", version: 1, state: { records: [{ collection: "things", id: "opaque", value: "http://old.example.test/hook" }], webhooks: { endpoints: [{ id: "endpoint-1", url: "http://old.example.test/hook", signUrl: "http://old.example.test/public" }], payloads: [["delivery-1", { endpoint: { id: "endpoint-1", url: "http://old.example.test/hook" } }]], deliveries: [["delivery-1", { endpointId: "endpoint-1", url: "http://old.example.test/hook" }]] } } } } } } })
  const unchanged = JSON.stringify(source), binding = { namespace: "alpha", service: "fixture", endpointId: "endpoint-1", endpointRef: "receiver", secretRef: "receiver-secret", signing: "replace" as const }
  await expect(planRestoreBindings(source, { bindings: [binding], endpoints: {} })).rejects.toThrow("unresolved endpoint")
  await expect(planRestoreBindings(source, { bindings: [binding], endpoints: { receiver: "http://new.example.test/hook" } })).rejects.toThrow("unresolved secret")
  const prepared = await planRestoreBindings(source, { bindings: [binding], endpoints: { receiver: "http://new.example.test/hook" } }, async () => "synthetic-runtime-only")
  const state = prepared.archive.namespaces.alpha?.services.fixture?.state as { records: {value:string}[]; webhooks: { endpoints: {url:string;signUrl:string;secret:string}[]; deliveries: [string,{url:string}][] } }
  expect(state.webhooks.endpoints[0]).toMatchObject({ url: "http://new.example.test/hook", signUrl: "http://new.example.test/hook", secret: "synthetic-runtime-only" })
  expect(state.webhooks.deliveries[0]?.[1].url).toBe("http://new.example.test/hook")
  expect(state.records[0]?.value).toBe("http://old.example.test/hook")
  expect(JSON.stringify(prepared.report)).not.toContain("synthetic-runtime-only")
  expect(JSON.stringify(prepared.report)).not.toContain("http://")
  expect(JSON.stringify(source)).toBe(unchanged)
  await expect(planRestoreBindings(source, { bindings: [binding, binding], endpoints: { receiver: "http://new.example.test/hook" } }, async () => "synthetic-runtime-only")).rejects.toThrow("ambiguous")
})
