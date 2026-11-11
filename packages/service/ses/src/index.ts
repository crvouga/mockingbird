import {
  AwsError,
  type AwsInput,
  type AwsOperation,
  AwsProtocolAPI,
  type AwsProtocolOptions,
  awsList,
  awsMd5,
  awsPage,
  awsParseXml,
  awsRecord,
  awsRequired,
  awsXml,
} from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class SesAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("ses", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "VerifyEmailIdentity",
        "VerifyEmailAddress",
        "VerifyDomainIdentity",
        "DeleteIdentity",
        "ListIdentities",
        "GetIdentityVerificationAttributes",
        "GetSendQuota",
        "GetSendStatistics",
        "SendEmail",
        "SendRawEmail",
        "CreateTemplate",
        "GetTemplate",
        "UpdateTemplate",
        "DeleteTemplate",
        "ListTemplates",
        "CreateConfigurationSet",
        "DeleteConfigurationSet",
        "ListConfigurationSets",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const identities = this.collection("identities"),
      templates = this.collection("templates"),
      sets = this.collection("sets")
    if (
      operation === "VerifyEmailIdentity" ||
      operation === "VerifyEmailAddress" ||
      operation === "VerifyDomainIdentity"
    ) {
      const domain = operation === "VerifyDomainIdentity",
        name = awsRequired(input, domain ? "Domain" : "EmailAddress")
      identities.insert(name, {
        VerificationStatus: "Success",
        Kind: domain ? "Domain" : "EmailAddress",
      })
      return domain ? { VerificationToken: this.ids.next("", 32) } : {}
    }
    if (operation === "DeleteIdentity") {
      identities.delete(awsRequired(input, "Identity"))
      return {}
    }
    if (operation === "ListIdentities")
      return {
        Identities: identities
          .list({
            order: "oldest",
            where: (item) => !input.IdentityType || item.Kind === input.IdentityType,
          })
          .map(({ id }) => id),
      }
    if (operation === "GetIdentityVerificationAttributes")
      return {
        VerificationAttributes: Object.fromEntries(
          awsList(input.Identities)
            .map(String)
            .filter((id) => identities.has(id))
            .map((id) => [id, { VerificationStatus: identities.get(id)?.VerificationStatus }]),
        ),
      }
    if (operation === "GetSendQuota")
      return {
        Max24HourSend: 200,
        MaxSendRate: 1,
        SentLast24Hours: this.collection("messages").list().length,
      }
    if (operation === "GetSendStatistics") return { SendDataPoints: [] }
    if (operation === "SendEmail" || operation === "SendRawEmail") {
      // Source may carry a display name: `"Billing" <billing@example.com>`. SES checks the address.
      const raw = String(input.Source ?? "")
      const source = (/<([^>]+)>\s*$/.exec(raw)?.[1] ?? raw).trim()
      if (
        operation === "SendEmail" &&
        !identities.has(source) &&
        !identities.has(source.split("@").at(-1) ?? "")
      )
        throw new AwsError("MessageRejected", "Email address is not verified")
      const id = this.ids.next("", 36)
      this.collection("messages").insert(id, {
        ...input,
        MessageId: id,
        Timestamp: this.now() / 1000,
      })
      return { MessageId: id }
    }
    if (operation === "CreateTemplate" || operation === "UpdateTemplate") {
      const template = awsRecord(input.Template),
        name = awsRequired(template, "TemplateName")
      if (operation === "CreateTemplate" && templates.has(name))
        throw new AwsError("AlreadyExists", "Template exists")
      if (operation === "UpdateTemplate" && !templates.has(name))
        throw new AwsError("TemplateDoesNotExist", "Template does not exist")
      templates.insert(name, { ...template, CreatedTimestamp: new Date(this.now()).toISOString() })
      return {}
    }
    if (operation === "GetTemplate")
      return {
        Template: this.get("templates", awsRequired(input, "TemplateName"), "TemplateDoesNotExist"),
      }
    if (operation === "DeleteTemplate") {
      templates.delete(awsRequired(input, "TemplateName"))
      return {}
    }
    if (operation === "ListTemplates")
      return {
        TemplatesMetadata: templates.list({ order: "oldest" }).map(({ value }) => ({
          Name: value.TemplateName,
          CreatedTimestamp: value.CreatedTimestamp,
        })),
      }
    if (operation === "CreateConfigurationSet") {
      const set = awsRecord(input.ConfigurationSet),
        name = awsRequired(set, "Name")
      if (sets.has(name))
        throw new AwsError("ConfigurationSetAlreadyExists", "Configuration set exists")
      sets.insert(name, set)
      return {}
    }
    if (operation === "DeleteConfigurationSet") {
      sets.delete(awsRequired(input, "ConfigurationSetName"))
      return {}
    }
    if (operation === "ListConfigurationSets")
      return { ConfigurationSets: sets.list({ order: "oldest" }).map(({ value }) => value) }
    return this.unsupported(operation)
  }
}
