import { describe, expect, test } from "bun:test"
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  SendTaskFailureCommand,
  SendTaskHeartbeatCommand,
  SendTaskSuccessCommand,
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn"
import { createClock } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

const machineArn = "arn:aws:states:us-east-1:000000000000:stateMachine:jobs"
const clientFor = (endpoint: string) =>
  new SFNClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 1,
  })

describe("AWS SFNClient against Step Functions mock", () => {
  test("start is idempotent while running and admin transitions exact output", async () => {
    const clock = createClock(() => 1_800_000_000_000)
    const server = await createServer({ clock, stateMachines: [{ name: "jobs", arn: machineArn }] })
    const client = clientFor(server.url)
    try {
      const started = await client.send(
        new StartExecutionCommand({
          stateMachineArn: machineArn,
          name: "job-1",
          input: JSON.stringify({ id: 1 }),
          traceHeader: "Root=fixture",
        }),
      )
      const replay = await client.send(
        new StartExecutionCommand({
          stateMachineArn: machineArn,
          name: "job-1",
          input: JSON.stringify({ id: 1 }),
        }),
      )
      expect(replay.executionArn).toBe(started.executionArn)
      expect(
        (await client.send(new DescribeExecutionCommand({ executionArn: started.executionArn })))
          .status,
      ).toBe("RUNNING")
      clock.advance(5_000)
      server.runtime.instance("default").transition(started.executionArn as string, "SUCCEEDED", {
        output: JSON.stringify({ ok: true }),
      })
      const finished = await client.send(
        new DescribeExecutionCommand({ executionArn: started.executionArn }),
      )
      expect(finished).toMatchObject({
        status: "SUCCEEDED",
        output: '{"ok":true}',
        name: "job-1",
        stateMachineArn: machineArn,
        traceHeader: "Root=fixture",
      })
      expect(finished.stopDate?.getTime()).toBe(1_800_000_005_000)
      await expect(
        client.send(
          new StartExecutionCommand({
            stateMachineArn: machineArn,
            name: "job-1",
            input: JSON.stringify({ id: 2 }),
          }),
        ),
      ).rejects.toMatchObject({ name: "ExecutionAlreadyExists" })
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("callback tokens succeed/fail tasks and history paginates", async () => {
    const server = await createServer({
      stateMachines: [{ name: "jobs", arn: machineArn, taskToken: true }],
    })
    const client = clientFor(server.url)
    try {
      const success = await client.send(
        new StartExecutionCommand({
          stateMachineArn: machineArn,
          name: "callback-success",
          input: "{}",
        }),
      )
      const token = server.runtime
        .instance("default")
        .state.executions.get(success.executionArn as string)?.taskToken
      await client.send(new SendTaskHeartbeatCommand({ taskToken: token }))
      await client.send(
        new SendTaskSuccessCommand({ taskToken: token, output: '{"result":"done"}' }),
      )
      expect(
        (await client.send(new DescribeExecutionCommand({ executionArn: success.executionArn })))
          .status,
      ).toBe("SUCCEEDED")
      const page = await client.send(
        new GetExecutionHistoryCommand({ executionArn: success.executionArn, maxResults: 2 }),
      )
      expect(page.events).toHaveLength(2)
      expect(page.nextToken).toBeString()
      const rest = await client.send(
        new GetExecutionHistoryCommand({
          executionArn: success.executionArn,
          nextToken: page.nextToken,
        }),
      )
      expect([...(page.events ?? []), ...(rest.events ?? [])].map((event) => event.type)).toEqual([
        "ExecutionStarted",
        "TaskScheduled",
        "TaskStarted",
        "TaskSucceeded",
        "ExecutionSucceeded",
      ])
      const failed = await client.send(
        new StartExecutionCommand({
          stateMachineArn: machineArn,
          name: "callback-fail",
          input: "{}",
        }),
      )
      const failedToken = server.runtime
        .instance("default")
        .state.executions.get(failed.executionArn as string)?.taskToken
      await client.send(
        new SendTaskFailureCommand({
          taskToken: failedToken,
          error: "WorkerError",
          cause: "fixture",
        }),
      )
      expect(
        await client.send(new DescribeExecutionCommand({ executionArn: failed.executionArn })),
      ).toMatchObject({ status: "FAILED", error: "WorkerError", cause: "fixture" })
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("stop aborts running executions", async () => {
    const server = await createServer({ stateMachines: [{ name: "jobs", arn: machineArn }] })
    const client = clientFor(server.url)
    try {
      const started = await client.send(
        new StartExecutionCommand({ stateMachineArn: machineArn, name: "stop-me", input: "{}" }),
      )
      await client.send(
        new StopExecutionCommand({
          executionArn: started.executionArn,
          error: "Canceled",
          cause: "test",
        }),
      )
      expect(
        await client.send(new DescribeExecutionCommand({ executionArn: started.executionArn })),
      ).toMatchObject({ status: "ABORTED", error: "Canceled", cause: "test" })
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
