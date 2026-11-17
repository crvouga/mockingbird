/**
 * `checkpointMutations: false` reaches the Kill Bill runtime: a write records no time-travel
 * checkpoint, and everything it wrote reads back as usual.
 */
import { expect, test } from "bun:test"
import { CHECKPOINT_HEADER } from "@crvouga/mockingbird-service"
import { createRuntime } from "./src/index.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "checkpoints-test",
}

for (const checkpointMutations of [true, false]) {
  test(`a write ${checkpointMutations ? "records" : "records no"} checkpoint with checkpointMutations: ${checkpointMutations}`, async () => {
    const runtime = createRuntime({ checkpointMutations })
    const created = await runtime.fetch(
      new Request("http://kill-bill.test/1.0/kb/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({ externalKey: "acct-ext", currency: "USD", name: "Ada" }),
      }),
    )
    expect(created.status).toBe(201)
    expect(created.headers.get(CHECKPOINT_HEADER) !== null).toBe(checkpointMutations)
    const read = await runtime.fetch(
      new Request("http://kill-bill.test/1.0/kb/accounts?externalKey=acct-ext", { headers }),
    )
    expect(((await read.json()) as { name: string }).name).toBe("Ada")
  })
}
