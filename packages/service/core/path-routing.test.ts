import { expect, test } from "bun:test"
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { validateMetadata } from "@crvouga/mockingbird-openapi-metadata"
import { createRuntime, createService, jsonRes } from "./src/index.js"

const operation = (operationId: string, path?: unknown) => ({
  operationId,
  ...(path === undefined ? {} : { "x-mockingbird": { path } }),
  parameters: (operationId === "invalid"
    ? ["id", "tail"]
    : operationId === "static"
      ? []
      : operationId === "single"
        ? ["id"]
        : ["tail"]
  ).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
  responses: { "200": { description: "ok" } },
})
const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "paths", version: "1" },
  paths: {
    "/single/{id}": { get: operation("single") },
    "/many/{tail}": { get: operation("many", { parameter: "tail" }) },
    "/many/static": { get: operation("static") },
    "/optional/{tail}": { get: operation("optional", { parameter: "tail", allowEmpty: true }) },
  },
})

test("explicit tail paths agree across dispatch, fault matching and journal", async () => {
  const runtime = createRuntime({
    name: "paths",
    document,
    create: ({ sqlite, namespace }) =>
      createService({
        sqlite,
        namespace,
        document,
        handlers: Object.fromEntries(
          ["single", "many", "static", "optional"].map((id) => [
            id,
            ({ params }: { params: Record<string, string> }) => jsonRes(200, { id, params }),
          ]),
        ),
        notFound: () => jsonRes(404, {}),
        onError: (error) => {
          throw error
        },
      }),
  })
  const call = (path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`http://paths.mock${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
    )
  expect((await call("/single/a/b")).status).toBe(404)
  expect((await call("/many")).status).toBe(404)
  for (const [path, id, params] of [
    ["/single/a", "single", { id: "a" }],
    ["/many/a/b", "many", { tail: "a/b" }],
    ["/many/a%2Fb", "many", { tail: "a/b" }],
    ["/many/static", "static", {}],
    ["/optional", "optional", { tail: "" }],
    ["/optional/", "optional", { tail: "" }],
  ] as const) {
    expect(await (await call(path)).json()).toEqual({ id, params })
    expect(runtime.journal.list().at(-1)?.operationId).toBe(id)
    await call("/__admin/faults", { operationId: id, count: 1, status: 503 })
    expect((await call(path)).status).toBe(503)
    expect((await call(path)).status).toBe(200)
  }
})

test("path metadata rejects nonterminal and malformed opt-ins", () => {
  for (const path of [
    { parameter: "wrong" },
    { parameter: "id" },
    { parameter: "tail", allowEmpty: "yes" },
    true,
  ]) {
    const invalid = parseOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "invalid", version: "1" },
      paths: { "/p/{id}/{tail}": { get: operation("invalid", path) } },
    })
    expect(validateMetadata(invalid).some((issue) => issue.includes("path"))).toBe(true)
  }
})
