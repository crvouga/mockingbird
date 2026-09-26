import { describe, expect, test } from "bun:test"
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn"
import { createClock } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

describe("Step Functions deterministic controls", () => {
  test("scripted completion follows the shared clock without polling sleeps", async () => {
    const clock = createClock(() => 100_000)
    const arn = "arn:aws:states:us-east-1:000000000000:stateMachine:scripted"
    const server = await createServer({
      clock,
      stateMachines: [
        {
          name: "scripted",
          arn,
          scripted: { status: "SUCCEEDED", output: '{"ready":true}', afterMs: 1_000 },
        },
      ],
    })
    const client = new SFNClient({
      endpoint: server.url,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      const started = await client.send(
        new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }),
      )
      expect(
        (await client.send(new DescribeExecutionCommand({ executionArn: started.executionArn })))
          .status,
      ).toBe("RUNNING")
      clock.advance(1_000)
      expect(
        await client.send(new DescribeExecutionCommand({ executionArn: started.executionArn })),
      ).toMatchObject({ status: "SUCCEEDED", output: '{"ready":true}' })
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("validation errors and namespaces match AWS-shaped failures", async () => {
    const arn = "arn:aws:states:us-east-1:000000000000:stateMachine:isolated"
    const server = await createServer({ stateMachines: [{ name: "isolated", arn }] })
    const client = new SFNClient({
      endpoint: server.url,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      maxAttempts: 1,
    })
    try {
      await expect(
        client.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{" })),
      ).rejects.toMatchObject({ name: "InvalidExecutionInput" })
      await expect(
        client.send(new StartExecutionCommand({ stateMachineArn: "bad", input: "{}" })),
      ).rejects.toMatchObject({ name: "InvalidArn" })
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "AWSStepFunctions.StartExecution",
          "x-mockingbird-namespace": "other",
        },
        body: JSON.stringify({ stateMachineArn: arn, input: "{}" }),
      })
      expect(response.status).toBe(200)
      const one = await client.send(
        new StartExecutionCommand({ stateMachineArn: arn, name: "only-default", input: "{}" }),
      )
      const other = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "AWSStepFunctions.DescribeExecution",
          "x-mockingbird-namespace": "other",
        },
        body: JSON.stringify({ executionArn: one.executionArn }),
      })
      expect(other.status).toBe(400)
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
