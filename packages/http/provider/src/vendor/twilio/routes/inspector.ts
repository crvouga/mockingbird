/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import type { InspectorTab, RouteContext } from "../../core/index.js";
import { chip, renderInspectorPage, section, table, type Block } from "../../core/index.js";
import { getTwilioStore } from "../store.js";
import { maskSecret } from "../helpers.js";

const SERVICE_LABEL = "Twilio";
const TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "verify", label: "Verify", href: "/?tab=verify" },
  { id: "calls", label: "Calls", href: "/?tab=calls" },
  { id: "conversations", label: "Conversations", href: "/?tab=conversations" },
  { id: "numbers", label: "Numbers", href: "/?tab=numbers" },
  { id: "services", label: "Services", href: "/?tab=services" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
];

type TabId = (typeof TABS)[number]["id"];

export function inspectorRoutes({ app, store }: RouteContext): void {
  const ts = () => getTwilioStore(store);

  app.get("/", async (c) => {
    const requested = c.req.query("tab") ?? "messages";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "messages";
    const body =
      active === "verify"
        ? verifyView()
        : active === "calls"
          ? callsView()
          : active === "conversations"
            ? conversationsView()
            : active === "numbers"
              ? numbersView()
              : active === "services"
                ? servicesView()
                : active === "auth"
                  ? authView()
                  : active === "webhooks"
                    ? webhooksView()
                    : messagesView();
    return c.html(await renderInspectorPage("Twilio Inspector", TABS, active, body, SERVICE_LABEL));
  });

  function messagesView(): Block[] {
    const rows = ts()
      .messages.all()
      .sort((a, b) => b.id - a.id)
      .map((message) => [
        message.sid,
        message.direction,
        chip(message.status),
        message.from ?? "",
        message.to,
        message.body ?? "",
        message.created_at,
      ]);
    return [section(
      "Messages",
      table(["SID", "Direction", "Status", "From", "To", "Body", "Created"], rows, "No messages."),
    )];
  }

  function verifyView(): Block[] {
    const serviceRows = ts()
      .verifyServices.all()
      .map((service) => [service.sid, service.friendly_name, service.code]);
    const verificationRows = ts()
      .verifications.all()
      .sort((a, b) => b.id - a.id)
      .map((verification) => [
        verification.sid,
        verification.to,
        verification.channel,
        chip(verification.status),
        verification.code,
        String(verification.attempts),
      ]);
    return [
      section("Verify Services", table(["SID", "Name", "Code"], serviceRows, "No Verify services.")),
      section(
        "Verifications",
        table(["SID", "To", "Channel", "Status", "Code", "Attempts"], verificationRows, "No verifications."),
      )
    ];
  }

  function callsView(): Block[] {
    const rows = ts()
      .calls.all()
      .sort((a, b) => b.id - a.id)
      .map((call) => [
        call.sid,
        call.direction,
        chip(call.status),
        call.from,
        call.to,
        call.twiml_steps.join(", "),
        call.created_at,
      ]);
    return [section("Calls", table(["SID", "Direction", "Status", "From", "To", "TwiML", "Created"], rows, "No calls."))];
  }

  function numbersView(): Block[] {
    const rows = ts()
      .phoneNumbers.all()
      .map((number) => [
        number.sid,
        number.phone_number,
        number.friendly_name,
        number.sms_url ?? "",
        number.voice_url ?? "",
      ]);
    return [section(
      "Phone Numbers",
      table(["SID", "Number", "Name", "SMS URL", "Voice URL"], rows, "No phone numbers."),
    )];
  }

  function conversationsView(): Block[] {
    const serviceRows = ts()
      .conversationServices.all()
      .map((service) => [
        service.sid,
        service.friendly_name,
        String(ts().conversations.count((item) => item.service_sid === service.sid)),
      ]);
    const conversationRows = ts()
      .conversations.all()
      .map((conversation) => [
        conversation.sid,
        conversation.friendly_name ?? "",
        conversation.unique_name ?? "",
        chip(conversation.state),
        String(ts().conversationParticipants.count((item) => item.conversation_sid === conversation.sid)),
        String(ts().conversationMessages.count((item) => item.conversation_sid === conversation.sid)),
      ]);
    return [
      section(
        "Conversation Services",
        table(["SID", "Name", "Conversations"], serviceRows, "No Conversation Services."),
      ),
      section(
        "Conversations",
        table(
          ["SID", "Name", "Unique Name", "State", "Participants", "Messages"],
          conversationRows,
          "No conversations.",
        ),
      )
    ];
  }

  function servicesView(): Block[] {
    const messagingRows = ts()
      .messagingServices.all()
      .map((service) => [
        service.sid,
        service.friendly_name,
        String(ts().messagingServicePhoneNumbers.count((item) => item.service_sid === service.sid)),
        service.status_callback ?? "",
      ]);
    return [section(
      "Messaging Services",
      table(["SID", "Name", "Senders", "Status Callback"], messagingRows, "No Messaging Services."),
    )];
  }

  function authView(): Block[] {
    const accountRows = ts()
      .accounts.all()
      .map((account) => [
        account.sid,
        account.friendly_name,
        chip(account.status),
        maskSecret(account.auth_token),
      ]);
    const keyRows = ts()
      .apiKeys.all()
      .map((key) => [
        key.sid,
        key.friendly_name,
        key.account_sid,
        chip(key.active ? "active" : "inactive"),
        maskSecret(key.secret),
      ]);
    return [
      section("Accounts", table(["SID", "Name", "Status", "Auth Token"], accountRows, "No accounts.")),
      section("API Keys", table(["SID", "Name", "Account", "Status", "Secret"], keyRows, "No API keys."))
    ];
  }

  function webhooksView(): Block[] {
    const rows = ts()
      .webhookDeliveries.all()
      .slice(-50)
      .reverse()
      .map((delivery) => [
        delivery.event,
        delivery.url,
        String(delivery.response_status ?? ""),
        chip(delivery.success ? "ok" : "failed"),
        delivery.error ?? "",
        delivery.created_at,
      ]);
    return [section(
      "Webhook Deliveries",
      table(["Event", "URL", "Status", "Result", "Error", "Created"], rows, "No webhook deliveries."),
    )];
  }
}


