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
export class SnsAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("sns", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "CreateTopic",
        "DeleteTopic",
        "ListTopics",
        "GetTopicAttributes",
        "SetTopicAttributes",
        "Subscribe",
        "Unsubscribe",
        "ListSubscriptions",
        "ListSubscriptionsByTopic",
        "GetSubscriptionAttributes",
        "SetSubscriptionAttributes",
        "ConfirmSubscription",
        "Publish",
        "PublishBatch",
        "TagResource",
        "UntagResource",
        "ListTagsForResource",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const topics = this.collection("topics"),
      subscriptions = this.collection("subscriptions")
    if (operation === "CreateTopic") {
      const name = awsRequired(input, "Name")
      if (!/^[\w-]{1,256}(\.fifo)?$/.test(name))
        throw new AwsError("InvalidParameter", "Invalid topic name")
      const arn = this.arn("", name, "sns")
      if (!topics.has(arn))
        topics.insert(arn, {
          TopicArn: arn,
          Name: name,
          Attributes: Object.fromEntries(
            awsList(input.Attributes)
              .map(awsRecord)
              .map((item) => [String(item.key), String(item.value)]),
          ),
          Tags: input.Tags ?? [],
        })
      return { TopicArn: arn }
    }
    if (operation === "ListTopics") {
      const page = awsPage(
        topics.list({ order: "oldest" }).map(({ id }) => ({ TopicArn: id })),
        input,
      )
      return { Topics: page.items, ...(page.token ? { NextToken: page.token } : {}) }
    }
    if (["ListSubscriptions", "ListSubscriptionsByTopic"].includes(operation)) {
      const page = awsPage(
        subscriptions
          .list({
            order: "oldest",
            where: (item) => operation === "ListSubscriptions" || item.TopicArn === input.TopicArn,
          })
          .map(({ value }) => value),
        input,
      )
      return { Subscriptions: page.items, ...(page.token ? { NextToken: page.token } : {}) }
    }
    if (operation === "Unsubscribe") {
      subscriptions.delete(awsRequired(input, "SubscriptionArn"))
      return {}
    }
    if (["GetSubscriptionAttributes", "SetSubscriptionAttributes"].includes(operation)) {
      const id = awsRequired(input, "SubscriptionArn"),
        item = this.get("subscriptions", id, "NotFound")
      if (operation === "GetSubscriptionAttributes")
        return {
          Attributes: {
            ...awsRecord(item.Attributes),
            SubscriptionArn: id,
            TopicArn: item.TopicArn,
            Protocol: item.Protocol,
            Endpoint: item.Endpoint,
            Owner: this.accountId,
            PendingConfirmation: "false",
            ConfirmationWasAuthenticated: "true",
          },
        }
      subscriptions.insert(id, {
        ...item,
        Attributes: {
          ...awsRecord(item.Attributes),
          [awsRequired(input, "AttributeName")]: input.AttributeValue,
        },
      })
      return {}
    }
    if (operation === "Publish" && input.PhoneNumber !== undefined && !input.TopicArn) {
      // Direct SMS: `Publish({ PhoneNumber, Message })` needs no topic. SNS accepts E.164 only.
      const phone = String(input.PhoneNumber)
      if (!/^\+[1-9]\d{1,14}$/.test(phone))
        throw new AwsError(
          "InvalidParameter",
          `Invalid parameter: PhoneNumber Reason: ${phone} is not valid to publish to`,
        )
      awsRequired(input, "Message")
      const messageId = this.ids.next("", 36)
      this.collection("messages").insert(messageId, {
        ...input,
        MessageId: messageId,
        PhoneNumber: phone,
        Timestamp: this.now() / 1000,
      })
      return { MessageId: messageId }
    }
    const id = String(input.TopicArn ?? input.ResourceArn ?? ""),
      topic = this.get("topics", id, "NotFound")
    if (operation === "DeleteTopic") {
      topics.delete(id)
      for (const row of subscriptions.list({ where: (item) => item.TopicArn === id }))
        subscriptions.delete(row.id)
      return {}
    }
    if (operation === "GetTopicAttributes")
      return {
        Attributes: {
          TopicArn: id,
          Owner: this.accountId,
          DisplayName: "",
          SubscriptionsConfirmed: String(
            subscriptions.list({ where: (item) => item.TopicArn === id }).length,
          ),
          SubscriptionsPending: "0",
          SubscriptionsDeleted: "0",
          ...awsRecord(topic.Attributes),
        },
      }
    if (operation === "SetTopicAttributes") {
      topics.insert(id, {
        ...topic,
        Attributes: {
          ...awsRecord(topic.Attributes),
          [awsRequired(input, "AttributeName")]: input.AttributeValue,
        },
      })
      return {}
    }
    if (operation === "Subscribe") {
      const protocol = awsRequired(input, "Protocol"),
        endpoint = awsRequired(input, "Endpoint")
      const prior = subscriptions.list({
        where: (item) =>
          item.TopicArn === id && item.Protocol === protocol && item.Endpoint === endpoint,
      })[0]
      if (prior) return { SubscriptionArn: prior.id }
      const arn = `${id}:${this.ids.next("", 36)}`
      subscriptions.insert(arn, {
        SubscriptionArn: arn,
        TopicArn: id,
        Protocol: protocol,
        Endpoint: endpoint,
        Owner: this.accountId,
        Attributes: {},
      })
      return { SubscriptionArn: arn }
    }
    if (operation === "ConfirmSubscription")
      return {
        SubscriptionArn:
          subscriptions.list({ where: (item) => item.TopicArn === id })[0]?.id ??
          `${id}:${this.ids.next("", 36)}`,
      }
    const publish = (message: AwsInput) => {
      awsRequired(message, "Message")
      const messageId = this.ids.next("", 36)
      this.collection("messages").insert(messageId, {
        ...message,
        MessageId: messageId,
        TopicArn: id,
        Timestamp: this.now() / 1000,
      })
      return { MessageId: messageId }
    }
    if (operation === "Publish") return publish(input)
    if (operation === "PublishBatch") {
      const successful = [],
        failed = []
      for (const item of awsList(input.PublishBatchRequestEntries).map(awsRecord)) {
        try {
          successful.push({ Id: item.Id, ...publish(item) })
        } catch (error) {
          failed.push({
            Id: item.Id,
            Code: "InvalidParameter",
            SenderFault: true,
            Message: String(error),
          })
        }
      }
      return { Successful: successful, Failed: failed }
    }
    if (operation === "ListTagsForResource") return { Tags: topic.Tags ?? [] }
    if (operation === "TagResource" || operation === "UntagResource") {
      const incoming = operation === "TagResource" ? awsList(input.Tags).map(awsRecord) : []
      const removed =
        operation === "UntagResource" ? awsList(input.TagKeys) : incoming.map((item) => item.Key)
      topics.insert(id, {
        ...topic,
        Tags: [
          ...awsList(topic.Tags)
            .map(awsRecord)
            .filter((item) => !removed.includes(item.Key)),
          ...incoming,
        ],
      })
      return {}
    }
    return this.unsupported(operation)
  }
}
