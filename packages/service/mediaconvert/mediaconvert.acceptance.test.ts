import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

const valid = {
  role: "role",
  settings: {
    inputs: [{ fileInput: "s3://in/a.mp4" }],
    outputGroups: [
      { outputGroupSettings: { fileGroupSettings: { destination: "s3://out/result/" } } },
    ],
  },
}
describe("MediaConvert contract", () => {
  test("admin controls expose settings and namespaces remain isolated", async () => {
    const runtime = createRuntime({ endpoint: "http://mock" })
    const created = await runtime.fetch(
      new Request("http://mock/2017-08-29/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(valid),
      }),
    )
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { job: { id: string } }).job.id
    const jobs = await runtime.fetch(new Request("http://mock/__admin/jobs"))
    expect(((await jobs.json()) as { jobs: unknown[] }).jobs).toHaveLength(1)
    const moved = await runtime.fetch(
      new Request(`http://mock/__admin/jobs/${id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ERROR", errorCode: 1099, errorMessage: "codec rejected" }),
      }),
    )
    expect(await moved.json()).toMatchObject({
      status: "ERROR",
      errorCode: 1099,
      errorMessage: "codec rejected",
    })
    const isolated = await runtime.fetch(
      new Request(`http://mock/2017-08-29/jobs/${id}`, {
        headers: { "x-mockingbird-namespace": "other" },
      }),
    )
    expect(isolated.status).toBe(404)
  })
})
