import { describe, expect, test } from "bun:test"
import {
  CancelJobCommand,
  CreateJobCommand,
  DescribeEndpointsCommand,
  GetJobCommand,
  MediaConvertClient,
} from "@aws-sdk/client-mediaconvert"
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { createServer as createS3Server } from "@crvouga/mockingbird-service-s3/server"
import { createServer } from "./src/server.js"

const credentials = { accessKeyId: "fixture", secretAccessKey: "fixture" }
const clientFor = (endpoint: string) =>
  new MediaConvertClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 })
const settings = {
  Inputs: [
    {
      FileInput: "s3://inputs/source.mp4",
      VideoSelector: {},
      AudioSelectors: { Default: { DefaultSelection: "DEFAULT" as const } },
    },
  ],
  OutputGroups: [
    {
      Name: "HLS",
      OutputGroupSettings: {
        Type: "HLS_GROUP_SETTINGS" as const,
        HlsGroupSettings: { Destination: "s3://outputs/video/" },
      },
      Outputs: [
        {
          ContainerSettings: { Container: "M3U8" as const },
          VideoDescription: { CodecSettings: { Codec: "H_264" as const } },
        },
      ],
    },
  ],
}

describe("AWS MediaConvertClient against MediaConvert mock", () => {
  test("discovers endpoint, preserves nested settings, and gets the job", async () => {
    const server = await createServer()
    const discovery = clientFor(server.url)
    let client: MediaConvertClient | undefined
    try {
      const endpoint = (await discovery.send(new DescribeEndpointsCommand({}))).Endpoints?.[0]?.Url
      expect(endpoint).toBe(server.url)
      client = clientFor(endpoint as string)
      const created = await client.send(
        new CreateJobCommand({
          Role: "arn:aws:iam::000000000000:role/MediaConvert",
          Queue: "arn:aws:mediaconvert:us-east-1:000000000000:queues/Default",
          UserMetadata: { asset: "fixture" },
          ClientRequestToken: "stable-token",
          Settings: settings,
        }),
      )
      expect(created.Job).toMatchObject({
        Status: "SUBMITTED",
        Role: "arn:aws:iam::000000000000:role/MediaConvert",
        UserMetadata: { asset: "fixture" },
        Settings: settings,
      })
      const replay = await client.send(
        new CreateJobCommand({
          Role: "arn:aws:iam::000000000000:role/MediaConvert",
          ClientRequestToken: "stable-token",
          Settings: settings,
        }),
      )
      expect(replay.Job?.Id).toBe(created.Job?.Id)
      expect((await client.send(new GetJobCommand({ Id: created.Job?.Id }))).Job?.Settings).toEqual(
        settings,
      )
    } finally {
      client?.destroy()
      discovery.destroy()
      await server.close()
    }
  })

  test("completion emits EventBridge events and writes deterministic S3 outputs", async () => {
    const events: Record<string, unknown>[] = []
    const s3 = await createS3Server({ buckets: ["outputs"], credentials })
    const server = await createServer({
      s3: { endpoint: s3.url, region: "us-east-1", ...credentials },
      webhooks: {
        endpoints: [{ url: "https://sink.test/events", events: ["*"] }],
        fetch: async (request) => {
          events.push((await request.json()) as Record<string, unknown>)
          return new Response(null, { status: 204 })
        },
      },
    })
    const client = clientFor(server.url)
    const s3Client = new S3Client({
      endpoint: s3.url,
      forcePathStyle: true,
      region: "us-east-1",
      credentials,
    })
    try {
      const created = await client.send(
        new CreateJobCommand({
          Role: "arn:aws:iam::000000000000:role/MediaConvert",
          Settings: settings,
        }),
      )
      const id = created.Job?.Id as string
      await server.runtime.instance("default").transition(id, "PROGRESSING", { progress: 40 })
      await server.runtime
        .instance("default")
        .transition(id, "COMPLETE", { durationInMs: 2500, names: ["master.m3u8", "part.ts"] })
      await server.runtime.webhooks.idle()
      expect((await client.send(new GetJobCommand({ Id: id }))).Job).toMatchObject({
        Status: "COMPLETE",
        OutputGroupDetails: [{ OutputDetails: [{ DurationInMs: 2500 }] }],
      })
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: "outputs", Key: "video/master.m3u8" }),
      )
      expect(await object.Body?.transformToString()).toContain("#EXTM3U")
      expect(events.map((event) => (event.detail as Record<string, unknown>).status)).toEqual([
        "SUBMITTED",
        "PROGRESSING",
        "COMPLETE",
      ])
      expect(events.at(-1)).toMatchObject({
        source: "aws.mediaconvert",
        "detail-type": "MediaConvert Job State Change",
        detail: {
          jobId: id,
          status: "COMPLETE",
          outputGroupDetails: [
            {
              playlistFilePaths: ["s3://outputs/video/master.m3u8", "s3://outputs/video/part.ts"],
            },
          ],
        },
      })
    } finally {
      client.destroy()
      s3Client.destroy()
      await server.close()
      await s3.close()
    }
  })

  test("cancels active jobs and returns modeled errors", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      await expect(
        client.send(new CreateJobCommand({ Role: "role", Settings: { Inputs: [] } })),
      ).rejects.toMatchObject({ name: "BadRequestException" })
      await expect(client.send(new GetJobCommand({ Id: "missing" }))).rejects.toMatchObject({
        name: "NotFoundException",
      })
      const created = await client.send(new CreateJobCommand({ Role: "role", Settings: settings }))
      await client.send(new CancelJobCommand({ Id: created.Job?.Id }))
      expect((await client.send(new GetJobCommand({ Id: created.Job?.Id }))).Job?.Status).toBe(
        "CANCELED",
      )
      await expect(
        client.send(new CancelJobCommand({ Id: created.Job?.Id })),
      ).rejects.toMatchObject({ name: "ConflictException" })
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
