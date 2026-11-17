/**
 * The boot control `adminControls.checkpointMutations` reaches a service that has no option of
 * its own for it: an OTLP export then records no time-travel checkpoint, and its spans read back.
 */
import { expect, test } from "bun:test"
import { CHECKPOINT_HEADER } from "@crvouga/mockingbird-service"
import { createRuntime } from "./src/index.js"

const span = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "backend" } }] },
      scopeSpans: [
        {
          scope: { name: "checkpoints" },
          spans: [
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              name: "reconcile.run",
              kind: 1,
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000000250000000",
            },
          ],
        },
      ],
    },
  ],
}

for (const checkpointMutations of [true, false]) {
  test(`an export ${checkpointMutations ? "records" : "records no"} checkpoint with adminControls.checkpointMutations: ${checkpointMutations}`, async () => {
    const runtime = createRuntime({ adminControls: { checkpointMutations } })
    const exported = await runtime.fetch(
      new Request("http://otel.mock/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer otel-ingest-token" },
        body: JSON.stringify(span),
      }),
    )
    expect(exported.status).toBe(200)
    expect(exported.headers.get(CHECKPOINT_HEADER) !== null).toBe(checkpointMutations)
    expect(runtime.instance().spans()).toHaveLength(1)
  })
}
