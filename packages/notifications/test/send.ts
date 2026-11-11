/**
 * Sends one realistic message through each emulator's vendor API, the way an application would.
 * Shared by the tests and `scripts/dev.ts`.
 */
import {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
  VerifyEmailIdentityCommand,
} from "@aws-sdk/client-ses"
import {
  CreateTopicCommand,
  PublishCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns"

export type Fetcher = (request: Request) => Response | Promise<Response>

export type Target = { url: string; fetch: Fetcher }

const ACCOUNT = "AC00000000000000000000000000000000"
const nsHeaders = (namespace: string): Record<string, string> =>
  namespace === "default" ? {} : { "x-mockingbird-namespace": namespace }

const ok = async (response: Response | Promise<Response>) => {
  const r = await response
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
  return r.json() as Promise<Record<string, unknown>>
}

export const twilioSms = (
  t: Target,
  input: { to: string; from?: string; body: string },
  namespace = "default",
) =>
  ok(
    t.fetch(
      new Request(`${t.url}/api/2010-04-01/Accounts/${ACCOUNT}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${ACCOUNT}:fixture-token`)}`,
          "content-type": "application/x-www-form-urlencoded",
          ...nsHeaders(namespace),
        },
        body: new URLSearchParams({
          To: input.to,
          From: input.from ?? "+15005550006",
          Body: input.body,
        }),
      }),
    ),
  )

export const twilioVerify = (t: Target, to: string, namespace = "default") =>
  ok(
    t.fetch(
      new Request(`${t.url}/verify/v2/Services/VA00000000000000000000000000000000/Verifications`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${ACCOUNT}:fixture-token`)}`,
          "content-type": "application/x-www-form-urlencoded",
          ...nsHeaders(namespace),
        },
        body: new URLSearchParams({ To: to, Channel: "sms" }),
      }),
    ),
  )

export const resendEmail = (t: Target, body: Record<string, unknown>, namespace = "default") =>
  ok(
    t.fetch(
      new Request(`${t.url}/emails`, {
        method: "POST",
        headers: {
          authorization: "Bearer re_test",
          "content-type": "application/json",
          ...nsHeaders(namespace),
        },
        body: JSON.stringify(body),
      }),
    ),
  )

export const fcmPush = (t: Target, message: Record<string, unknown>, namespace = "default") =>
  ok(
    t.fetch(
      new Request(`${t.url}/v1/projects/demo-project/messages:send`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-token",
          "content-type": "application/json",
          ...nsHeaders(namespace),
        },
        body: JSON.stringify({ message }),
      }),
    ),
  )

export const fcmRegister = (
  t: Target,
  token: string,
  platform: "android" | "ios" | "web",
  namespace = "default",
) =>
  ok(
    t.fetch(
      new Request(`${t.url}/__admin/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", ...nsHeaders(namespace) },
        body: JSON.stringify({ token, platform, project: "demo-project" }),
      }),
    ),
  )

const awsConfig = (t: Target) => ({
  endpoint: t.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

export const sesClient = (t: Target) => new SESClient(awsConfig(t))
export const snsClient = (t: Target) => new SNSClient(awsConfig(t))

export const sesEmail = async (t: Target) => {
  const ses = sesClient(t)
  await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: "billing@shop.example" }))
  return ses.send(
    new SendEmailCommand({
      Source: "Shop Billing <billing@shop.example>",
      Destination: { ToAddresses: ["ada@example.com"], CcAddresses: ["accounts@example.com"] },
      Message: {
        Subject: { Data: "Your receipt #1042" },
        Body: {
          Html: { Data: "<h1>Thanks, Ada</h1><p>Total: <b>$42.00</b></p>" },
          Text: { Data: "Thanks, Ada. Total: $42.00" },
        },
      },
    }),
  )
}

export const sesRawEmail = (t: Target) =>
  sesClient(t).send(
    new SendRawEmailCommand({
      Source: "reports@shop.example",
      Destinations: ["grace@example.com"],
      RawMessage: {
        Data: new TextEncoder().encode(
          [
            "From: Reports <reports@shop.example>",
            "To: grace@example.com",
            "Subject: =?UTF-8?B?V2Vla2x5IHJlcG9ydCDinIU=?=",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="outer"',
            "",
            "--outer",
            'Content-Type: multipart/alternative; boundary="inner"',
            "",
            "--inner",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Plain report",
            "--inner",
            "Content-Type: text/html; charset=utf-8",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "<p>HTML =E2=9C=85 report</p>",
            "--inner--",
            "--outer",
            'Content-Type: text/csv; name="report.csv"',
            'Content-Disposition: attachment; filename="report.csv"',
            "Content-Transfer-Encoding: base64",
            "",
            btoa("a,b\n1,2\n"),
            "--outer--",
            "",
          ].join("\r\n"),
        ),
      },
    }),
  )

export const snsSms = (t: Target, phone: string, message: string) =>
  snsClient(t).send(new PublishCommand({ PhoneNumber: phone, Message: message }))

export const snsTopicFanout = async (t: Target) => {
  const sns = snsClient(t)
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "order-alerts" }))
  await sns.send(new SubscribeCommand({ TopicArn, Protocol: "sms", Endpoint: "+12025550188" }))
  await sns.send(new SubscribeCommand({ TopicArn, Protocol: "email", Endpoint: "ops@example.com" }))
  return sns.send(
    new PublishCommand({
      TopicArn,
      Subject: "Order 1042 shipped",
      Message: "Order 1042 has shipped.",
    }),
  )
}

export const customerioSend = (
  t: Target,
  channel: "email" | "sms",
  body: Record<string, unknown>,
) =>
  ok(
    t.fetch(
      new Request(`${t.url}/v1/send/${channel}`, {
        method: "POST",
        headers: { authorization: "Bearer app-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )

export const mailosaurIngest = (t: Target, body: Record<string, unknown>) =>
  ok(
    t.fetch(
      new Request(`${t.url}/__admin/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )
