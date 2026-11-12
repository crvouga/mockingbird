import { createRuntime } from "@crvouga/mockingbird-service-aws"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { call, inspector, openTab, phone, SHARED_SOURCES } from "./inspector.js"

/**
 * The AWS emulator's inspector (`/_inspector`): S3 buckets and their objects, SQS queues, IAM
 * users and roles. The default store has one bucket, one queue and one user; the stories add
 * more through S3, SQS and IAM as an SDK would.
 */
export default {
  title: "Admin/Inspectors/AWS",
  parameters: {
    layout: "fullscreen",
    sources: [...SHARED_SOURCES, "packages/http/provider/src/vendor/aws/routes/inspector.ts"],
  },
} satisfies Meta

const ORIGIN = "https://aws.mock"
const signed = (service: string) => ({
  authorization: `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=storybook`,
})
const query = (service: string, params: Record<string, string>) => ({
  method: "POST",
  headers: { ...signed(service), "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params).toString(),
})

/** Uploads in two buckets, a jobs queue with work waiting, a deploy user and role. */
async function account() {
  const aws = createRuntime()
  for (const bucket of ["uploads", "invoices"])
    await call(aws, `${ORIGIN}/${bucket}`, { method: "PUT", headers: signed("s3") })
  for (const [key, type, body] of [
    ["avatars/alice.png", "image/png", "PNG"],
    ["avatars/bob.png", "image/png", "PNG"],
    ["exports/2026-11.csv", "text/csv", "id,total\n1,900\n"],
  ] as const)
    await call(aws, `${ORIGIN}/uploads/${key}`, {
      method: "PUT",
      headers: { ...signed("s3"), "content-type": type },
      body,
    })
  await call(aws, `${ORIGIN}/invoices/in_1042.pdf`, {
    method: "PUT",
    headers: { ...signed("s3"), "content-type": "application/pdf" },
    body: "%PDF-1.7",
  })
  const created = await call(
    aws,
    `${ORIGIN}/sqs/`,
    query("sqs", { Action: "CreateQueue", QueueName: "jobs" }),
  )
  const queue = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(created)?.[1] ?? ""
  await call(
    aws,
    `${ORIGIN}/sqs/`,
    query("sqs", {
      Action: "CreateQueue",
      QueueName: "events.fifo",
      "Attribute.1.Name": "FifoQueue",
      "Attribute.1.Value": "true",
    }),
  )
  for (const body of ["resize avatars/alice.png", "email receipt in_1042"])
    await call(
      aws,
      `${ORIGIN}/sqs/`,
      query("sqs", { Action: "SendMessage", QueueUrl: queue, MessageBody: body }),
    )
  await call(aws, `${ORIGIN}/iam/`, query("iam", { Action: "CreateUser", UserName: "deployer" }))
  await call(
    aws,
    `${ORIGIN}/iam/`,
    query("iam", { Action: "CreateAccessKey", UserName: "deployer" }),
  )
  await call(
    aws,
    `${ORIGIN}/iam/`,
    query("iam", {
      Action: "CreateRole",
      RoleName: "lambda-exec",
      AssumeRolePolicyDocument: "{}",
      Description: "Runs the image resizer",
    }),
  )
  return aws
}

/** S3: every bucket, then each bucket's objects. */
export const S3: StoryObj = inspector(account, `${ORIGIN}/_inspector?tab=s3`, "exports/2026-11.csv")

export const SQS: StoryObj = inspector(account, `${ORIGIN}/_inspector?tab=sqs`, "events.fifo")

export const IAM: StoryObj = inspector(account, `${ORIGIN}/_inspector?tab=iam`, "lambda-exec")

/** The store as the emulator boots: its default bucket, queue and user, no roles. */
export const DefaultStore: StoryObj = inspector(
  createRuntime,
  `${ORIGIN}/_inspector?tab=iam`,
  "No roles",
)

/** Following the SQS tab from S3. */
export const SwitchingTabs: StoryObj = {
  ...S3,
  play: async ({ canvasElement }) => openTab(canvasElement, "SQS", "jobs"),
}

export const OnAPhone: StoryObj = { ...S3, globals: phone }
