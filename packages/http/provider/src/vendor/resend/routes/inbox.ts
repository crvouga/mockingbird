/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import type { RouteContext } from "../../core/index.js";
import { chip, renderProviderPage, type Block, type NavItem, type Status } from "../../core/index.js";
import { getResendStore } from "../store.js";

const SERVICE_LABEL = "Resend";

const NAV: NavItem[] = [{ label: "Inbox", href: "/inbox", current: true }];

function statusOf(status: string): Status {
  return status === "delivered" ? "ok" : status === "bounced" ? "error" : "neutral";
}

export function inboxRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const rs = () => getResendStore(store);

  app.get("/inbox", async (c) => {
    const emails = rs().emails.all().reverse();

    return c.html(
      await renderProviderPage({
        layout: "app",
        service: SERVICE_LABEL,
        title: "Inbox",
        description: `${emails.length} email${emails.length !== 1 ? "s" : ""} sent`,
        nav: NAV,
        blocks: [
          {
            type: "links",
            empty: "No emails sent yet. Use POST /emails to send one.",
            items: emails.map((email) => ({
              href: `/inbox/${email.uuid}`,
              title: email.subject,
              description: `${email.from} → ${email.to.join(", ")}`,
              letter: (email.from?.[0] ?? "?").toUpperCase(),
              status: { label: email.status, status: statusOf(email.status) },
            })),
          },
        ],
      }),
    );
  });

  app.get("/inbox/:id", async (c) => {
    const id = c.req.param("id");
    const email = rs().emails.findOneBy("uuid", id);

    if (!email) {
      return c.html(
        await renderProviderPage({
          layout: "app",
          service: SERVICE_LABEL,
          title: "Not Found",
          nav: NAV,
          blocks: [{ type: "empty", title: "Email not found", description: "The requested email was not found." }],
        }),
        404,
      );
    }

    const details: Extract<Block, { type: "details" }>["items"] = [
      { label: "Status", value: chip(email.status, statusOf(email.status)) },
      { label: "From", value: email.from },
      { label: "To", value: email.to.join(", ") },
    ];
    if (email.cc.length > 0) details.push({ label: "Cc", value: email.cc.join(", ") });
    if (email.bcc.length > 0) details.push({ label: "Bcc", value: email.bcc.join(", ") });
    details.push({ label: "Created", value: email.created_at, mono: true });
    details.push({ label: "Last event", value: email.last_event });
    if (email.scheduled_at) details.push({ label: "Scheduled", value: email.scheduled_at, mono: true });

    const blocks: Block[] = [{ type: "details", items: details }];
    if (email.tags.length > 0) {
      blocks.push({
        type: "chips",
        chips: email.tags.map((tag) => ({ label: `${tag.name}: ${tag.value}`, status: "neutral" })),
      });
    }
    blocks.push({
      type: "section",
      title: "Preview",
      blocks: [
        email.html
          ? { type: "frame", title: `Preview of ${email.subject}`, html: email.html }
          : email.text
            ? { type: "code", label: "text/plain", code: email.text }
            : { type: "empty", title: "No content" },
      ],
    });

    return c.html(
      await renderProviderPage({
        layout: "app",
        service: SERVICE_LABEL,
        title: email.subject,
        description: `Email ${email.uuid}`,
        nav: NAV,
        blocks,
      }),
    );
  });
}
