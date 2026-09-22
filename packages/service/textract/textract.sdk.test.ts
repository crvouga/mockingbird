import { describe, expect, test } from "bun:test"
import {
  AnalyzeDocumentCommand,
  GetDocumentAnalysisCommand,
  StartDocumentAnalysisCommand,
  TextractClient,
} from "@aws-sdk/client-textract"
import { createServer } from "./src/server.js"
import type { TextractCorpus } from "./src/state.js"

const corpus: TextractCorpus = {
  bucket: "fixtures",
  name: "invoice.pdf",
  version: "v1",
  pages: 2,
  pageSize: 3,
  blocks: [
    {
      id: "p1",
      blockType: "PAGE",
      page: 1,
      geometry: { boundingBox: { width: 1, height: 1, left: 0, top: 0 }, polygon: [] },
      relationships: [{ type: "CHILD", ids: ["line1", "table1"] }],
    },
    {
      id: "line1",
      blockType: "LINE",
      page: 1,
      text: "Patient Jane",
      confidence: 99,
      relationships: [{ type: "CHILD", ids: ["word1"] }],
    },
    { id: "word1", blockType: "WORD", page: 1, text: "Jane", confidence: 98 },
    {
      id: "table1",
      blockType: "TABLE",
      page: 1,
      relationships: [{ type: "CHILD", ids: ["cell1"] }],
    },
    {
      id: "cell1",
      blockType: "CELL",
      page: 1,
      rowIndex: 1,
      columnIndex: 1,
      rowSpan: 1,
      columnSpan: 1,
      relationships: [{ type: "CHILD", ids: ["word2"] }],
    },
    { id: "word2", blockType: "WORD", page: 1, text: "Amount", confidence: 97 },
    {
      id: "p2",
      blockType: "PAGE",
      page: 2,
      relationships: [{ type: "CHILD", ids: ["key", "value"] }],
    },
    {
      id: "key",
      blockType: "KEY_VALUE_SET",
      page: 2,
      entityTypes: ["KEY"],
      relationships: [{ type: "VALUE", ids: ["value"] }],
    },
    {
      id: "value",
      blockType: "KEY_VALUE_SET",
      page: 2,
      entityTypes: ["VALUE"],
      relationships: [{ type: "CHILD", ids: ["selected"] }],
    },
    {
      id: "selected",
      blockType: "SELECTION_ELEMENT",
      page: 2,
      selectionStatus: "SELECTED",
      confidence: 96,
    },
  ],
  warnings: [{ errorCode: "PAGE_CHARACTERS_EXCEEDED", pages: [2] }],
}
const clientFor = (endpoint: string) =>
  new TextractClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 1,
  })

describe("AWS TextractClient against Textract mock", () => {
  test("runs a multi-page async graph through stable scoped pagination", async () => {
    const events: Record<string, unknown>[] = []
    const server = await createServer({
      corpora: [corpus],
      webhooks: {
        endpoints: [{ url: "https://sink.test/textract", events: ["*"] }],
        fetch: async (request) => {
          events.push((await request.json()) as Record<string, unknown>)
          return new Response(null, { status: 204 })
        },
      },
    })
    const client = clientFor(server.url)
    try {
      const request = {
        DocumentLocation: { S3Object: { Bucket: "fixtures", Name: "invoice.pdf", Version: "v1" } },
        FeatureTypes: ["TABLES" as const, "FORMS" as const],
        ClientRequestToken: "same",
        JobTag: "invoice-1",
        NotificationChannel: {
          RoleArn: "arn:aws:iam::000000000000:role/Textract",
          SNSTopicArn: "arn:aws:sns:us-east-1:000000000000:textract",
        },
      }
      const started = await client.send(new StartDocumentAnalysisCommand(request))
      const replay = await client.send(new StartDocumentAnalysisCommand(request))
      expect(replay.JobId).toBe(started.JobId)
      expect(
        (await client.send(new GetDocumentAnalysisCommand({ JobId: started.JobId }))).JobStatus,
      ).toBe("IN_PROGRESS")
      server.runtime
        .instance("default")
        .transition(started.JobId as string, "PARTIAL_SUCCESS", "page 2 warning")
      const seen = []
      let token: string | undefined
      do {
        const page = await client.send(
          new GetDocumentAnalysisCommand({
            JobId: started.JobId,
            MaxResults: 3,
            ...(token ? { NextToken: token } : {}),
          }),
        )
        seen.push(...(page.Blocks ?? []))
        token = page.NextToken
        expect(page.DocumentMetadata?.Pages).toBe(2)
      } while (token)
      expect(seen.map((block) => block.BlockType)).toEqual([
        "PAGE",
        "LINE",
        "WORD",
        "TABLE",
        "CELL",
        "WORD",
        "PAGE",
        "KEY_VALUE_SET",
        "KEY_VALUE_SET",
        "SELECTION_ELEMENT",
      ])
      expect(seen.find((block) => block.Id === "key")?.Relationships?.[0]?.Ids).toEqual(["value"])
      await server.runtime.webhooks.idle()
      expect(events).toEqual([
        expect.objectContaining({
          JobId: started.JobId,
          Status: "PARTIAL_SUCCESS",
          API: "StartDocumentAnalysis",
          JobTag: "invoice-1",
        }),
      ])
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("analyzes synchronously and enforces idempotency and token scope", async () => {
    const server = await createServer({ corpora: [corpus] })
    const client = clientFor(server.url)
    try {
      const sync = await client.send(
        new AnalyzeDocumentCommand({
          Document: { S3Object: { Bucket: "fixtures", Name: "invoice.pdf", Version: "v1" } },
          FeatureTypes: ["TABLES"],
        }),
      )
      expect(sync.Blocks).toHaveLength(10)
      const one = await client.send(
        new StartDocumentAnalysisCommand({
          DocumentLocation: {
            S3Object: { Bucket: "fixtures", Name: "invoice.pdf", Version: "v1" },
          },
          FeatureTypes: ["TABLES"],
          ClientRequestToken: "conflict",
        }),
      )
      await expect(
        client.send(
          new StartDocumentAnalysisCommand({
            DocumentLocation: {
              S3Object: { Bucket: "fixtures", Name: "invoice.pdf", Version: "v1" },
            },
            FeatureTypes: ["FORMS"],
            ClientRequestToken: "conflict",
          }),
        ),
      ).rejects.toMatchObject({ name: "IdempotentParameterMismatchException" })
      server.runtime.instance("default").transition(one.JobId as string, "SUCCEEDED")
      const first = await client.send(
        new GetDocumentAnalysisCommand({ JobId: one.JobId, MaxResults: 1 }),
      )
      const two = await client.send(
        new StartDocumentAnalysisCommand({
          DocumentLocation: {
            S3Object: { Bucket: "fixtures", Name: "invoice.pdf", Version: "v1" },
          },
          FeatureTypes: ["TABLES"],
        }),
      )
      server.runtime.instance("default").transition(two.JobId as string, "SUCCEEDED")
      await expect(
        client.send(
          new GetDocumentAnalysisCommand({ JobId: two.JobId, NextToken: first.NextToken }),
        ),
      ).rejects.toMatchObject({ name: "InvalidParameterException" })
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
