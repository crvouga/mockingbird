import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

describe("Textract contract", () => {
  test("admin seeding, failure controls, and namespaces are isolated", async () => {
    const runtime = createRuntime()
    const seed = {
      bucket: "docs",
      name: "a.pdf",
      blocks: [{ id: "page", blockType: "PAGE", confidence: 12 }],
    }
    expect(
      (
        await runtime.fetch(
          new Request("http://mock/__admin/corpora", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(seed),
          }),
        )
      ).status,
    ).toBe(201)
    const start = await runtime.fetch(
      new Request("http://mock", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "Textract.StartDocumentAnalysis",
        },
        body: JSON.stringify({
          documentLocation: { s3Object: { bucket: "docs", name: "a.pdf" } },
          featureTypes: ["TABLES"],
        }),
      }),
    )
    const id = ((await start.json()) as { JobId: string }).JobId
    const moved = await runtime.fetch(
      new Request(`http://mock/__admin/jobs/${id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "FAILED", statusMessage: "bad input" }),
      }),
    )
    expect(await moved.json()).toMatchObject({ status: "FAILED", statusMessage: "bad input" })
    const isolated = await runtime.fetch(
      new Request("http://mock", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "Textract.GetDocumentAnalysis",
          "x-mockingbird-namespace": "other",
        },
        body: JSON.stringify({ jobId: id }),
      }),
    )
    expect(isolated.status).toBe(400)
    expect(await isolated.json()).toMatchObject({ __type: "InvalidJobIdException" })
  })
})
