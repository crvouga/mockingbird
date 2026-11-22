/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import type { RouteContext, InspectorTab } from "../../core/index.js";
import { renderInspectorPage, section, table, type Block } from "../../core/index.js";
import { getAwsStore } from "../store.js";

const SERVICE_LABEL = "AWS";

const TABS: InspectorTab[] = [
  { id: "s3", label: "S3", href: "/_inspector?tab=s3" },
  { id: "sqs", label: "SQS", href: "/_inspector?tab=sqs" },
  { id: "iam", label: "IAM", href: "/_inspector?tab=iam" },
];

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const aws = () => getAwsStore(store);

  app.get("/_inspector", async (c) => {
    const tab = c.req.query("tab") ?? "s3";
    const s3Store = aws();

    const buckets = s3Store.s3Buckets.all();
    const queues = s3Store.sqsQueues.all();
    const users = s3Store.iamUsers.all();
    const roles = s3Store.iamRoles.all();

    const blocks: Block[] = [];

    if (tab === "s3") {
      blocks.push(
        counted(
          "S3 Buckets",
          buckets.length,
          table(
            ["Bucket", "Objects", "Region", "Created"],
            buckets.map((b) => [
              b.bucket_name,
              String(s3Store.s3Objects.findBy("bucket_name", b.bucket_name).length),
              b.region,
              b.creation_date,
            ]),
            "No buckets",
          ),
        ),
      );

      for (const bucket of buckets) {
        const objects = s3Store.s3Objects.findBy("bucket_name", bucket.bucket_name);
        if (objects.length > 0) {
          blocks.push(
            counted(
              `${bucket.bucket_name} objects`,
              objects.length,
              table(
                ["Key", "Size", "Type", "Last Modified"],
                objects.map((o) => [o.key, String(o.content_length), o.content_type, o.last_modified]),
                "No objects",
              ),
            ),
          );
        }
      }
    } else if (tab === "sqs") {
      blocks.push(
        counted(
          "SQS Queues",
          queues.length,
          table(
            ["Queue", "Messages", "FIFO", "Visibility Timeout"],
            queues.map((q) => [
              q.queue_name,
              String(s3Store.sqsMessages.findBy("queue_name", q.queue_name).length),
              q.fifo ? "Yes" : "No",
              `${q.visibility_timeout}s`,
            ]),
            "No queues",
          ),
        ),
      );
    } else if (tab === "iam") {
      blocks.push(
        counted(
          "IAM Users",
          users.length,
          table(
            ["User", "User ID", "Access Keys", "ARN"],
            users.map((u) => [u.user_name, u.user_id, String(u.access_keys.length), u.arn]),
            "No users",
          ),
        ),
        counted(
          "IAM Roles",
          roles.length,
          table(
            ["Role", "Role ID", "Description", "ARN"],
            roles.map((r) => [r.role_name, r.role_id, r.description, r.arn]),
            "No roles",
          ),
        ),
      );
    }

    return c.html(await renderInspectorPage("Inspector", TABS, tab, blocks, SERVICE_LABEL));
  });
}

/** A section with its row count beside the title. */
function counted(title: string, count: number, ...blocks: Block[]): Block {
  return { ...section(title, ...blocks), count } as Block;
}
