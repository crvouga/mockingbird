/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import type { InspectorTab, RouteContext, WebhookDelivery, WebhookSubscription } from "../../core/index.js";
import { chip, renderInspectorPage, section, table, type Block, type Inline, type Rich } from "../../core/index.js";
import { getSlackStore } from "../store.js";
import type {
  SlackBookmark,
  SlackChannel,
  SlackEphemeralMessage,
  SlackIncomingWebhook,
  SlackInstallation,
  SlackMessage,
  SlackOAuthApp,
  SlackPin,
  SlackScheduledMessage,
  SlackToken,
  SlackView,
  SlackViewTrigger,
} from "../entities.js";
import { compareSlackBookmarks } from "./bookmarks.js";

const SERVICE_LABEL = "Slack";

const INSPECTOR_TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "channels", label: "Channels", href: "/?tab=channels" },
  { id: "files", label: "Files", href: "/?tab=files" },
  { id: "views", label: "Views", href: "/?tab=views" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "events", label: "Events", href: "/?tab=events" },
];

type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];

function timeAgo(isoDate: string, clockNow: () => number = Date.now): string {
  const seconds = Math.floor((clockNow() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function collectTextValues(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const text = record.text;
  if (typeof text === "string" && text.trim().length > 0) {
    output.push(text);
  } else {
    collectTextValues(text, output);
  }
  collectTextValues(record.fields, output);
  collectTextValues(record.elements, output);
  collectTextValues(record.accessory, output);
}

function richMessagePreview(
  msg: Pick<SlackMessage, "text" | "blocks" | "attachments" | "files"> | SlackScheduledMessage,
): string {
  if (msg.text.trim().length > 0) return msg.text;

  const blockText: string[] = [];
  collectTextValues(msg.blocks, blockText);
  if (blockText.length > 0) return blockText.join(" ");

  const attachmentText =
    msg.attachments
      ?.flatMap((attachment) => [attachment.text, attachment.title])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0) ?? [];
  if (attachmentText.length > 0) return attachmentText.join(" ");

  const files = "files" in msg ? msg.files : undefined;
  const fileText = files?.map((file) => file.title || file.name).filter((value) => value.trim().length > 0) ?? [];
  if (fileText.length > 0) return fileText.join(" ");

  if (msg.blocks?.length) return `${msg.blocks.length} ${msg.blocks.length === 1 ? "block" : "blocks"}`;
  if (msg.attachments?.length) {
    return `${msg.attachments.length} ${msg.attachments.length === 1 ? "attachment" : "attachments"}`;
  }
  if (files?.length) return `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return msg.text;
}

function viewPreview(view: SlackView): string {
  const blockText: string[] = [];
  collectTextValues(view.blocks, blockText);
  if (blockText.length > 0) return blockText.join(" ");

  const title = view.title?.text;
  if (typeof title === "string" && title.trim().length > 0) return title;

  if (view.callback_id) return view.callback_id;
  if (view.external_id) return view.external_id;
  return `${view.blocks.length} ${view.blocks.length === 1 ? "block" : "blocks"}`;
}

type Tone = "granted" | "requested" | "denied";

const TONE = { granted: "ok", requested: "neutral", denied: "error" } as const;

function badge(label: string, tone: Tone = "requested"): Inline {
  return chip(label, TONE[tone]);
}

function renderReactionBadges(reactions: Array<{ name: string; count: number }>): Inline[] {
  return reactions.map((reaction) => badge(`:${reaction.name}: ${reaction.count}`, "granted"));
}

function linkCell(href: string, label: string): Inline {
  return { link: label, href };
}

function scopePreview(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "";
  return scopes.join(", ");
}

function userLabel(users: Map<string, string>, id: string): string {
  return users.get(id) ?? id;
}

function channelLabel(ch: SlackChannel): string {
  if (ch.is_im) return `DM ${ch.name}`;
  if (ch.is_mpim) return `MPIM ${ch.name}`;
  if (ch.is_private) return `private ${ch.name}`;
  return `# ${ch.name}`;
}

function channelKind(ch: SlackChannel): string {
  if (ch.is_im) return "DM";
  if (ch.is_mpim) return "MPIM";
  if (ch.is_private) return "Private";
  return "Public";
}

function openStateLabel(ch: SlackChannel, users: Map<string, string>): string {
  if (ch.is_open_by_user) {
    const openUsers = Object.entries(ch.is_open_by_user)
      .filter(([, isOpen]) => isOpen === true)
      .map(([userId]) => userLabel(users, userId));
    return openUsers.length > 0 ? openUsers.join(", ") : "closed";
  }
  return ch.is_open ? "open" : "closed";
}

function maskToken(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function sortedChannels(channels: SlackChannel[]): SlackChannel[] {
  return [...channels].sort(
    (a, b) =>
      Number(a.is_archived) - Number(b.is_archived) ||
      channelKind(a).localeCompare(channelKind(b)) ||
      a.name.localeCompare(b.name),
  );
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);

  app.get("/", async (c) => {
    const team = ss().teams.all()[0];
    const requestedTab = c.req.query("tab") ?? "messages";
    const activeTab = INSPECTOR_TABS.some((tab) => tab.id === requestedTab)
      ? (requestedTab as InspectorTabId)
      : "messages";
    const users = buildUserMap();

    const body =
      activeTab === "channels"
        ? renderChannelsView(users)
        : activeTab === "files"
          ? renderFilesView(users)
          : activeTab === "views"
            ? renderViewsView(users)
            : activeTab === "auth"
              ? renderAuthView()
              : activeTab === "events"
                ? renderEventsView()
                : renderMessagesView(c.req.query("channel") ?? "", users);

    return c.html(
      await renderInspectorPage(
        `${team?.name ?? "Slack"} - Message Inspector`,
        INSPECTOR_TABS,
        activeTab,
        body,
        SERVICE_LABEL,
      ),
    );
  });

  function buildUserMap(): Map<string, string> {
    const userMap = new Map<string, string>();
    for (const u of ss().users.all()) {
      userMap.set(u.user_id, u.name);
      userMap.set(u.name, u.name);
    }
    for (const b of ss().bots.all()) {
      userMap.set(b.bot_id, b.name);
      if (b.user_id) userMap.set(b.user_id, b.name);
    }
    return userMap;
  }

  function renderMessagesView(requestedChannel: string, users: Map<string, string>): Block[] {
    const channels = sortedChannels(ss().channels.all());
    const visibleChannels = channels.filter((ch) => !ch.is_archived);
    const activeChannel =
      channels.find((ch) => ch.channel_id === requestedChannel) ?? visibleChannels[0] ?? channels[0];
    if (!activeChannel) {
      return [section("Messages", { type: "empty", title: "No conversations in the emulator store." })];
    }

    const channelMessages = ss()
      .messages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1));
    const messages = channelMessages.slice(0, 50);
    const threads = channelMessages
      .filter((message) => message.thread_ts && message.thread_ts !== message.ts)
      .slice(0, 20);
    const ephemeralMessages = ss()
      .ephemeralMessages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1))
      .slice(0, 20);
    const scheduledMessages = ss()
      .scheduledMessages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => a.post_at - b.post_at)
      .slice(0, 20);
    const pins = ss()
      .pins.findBy("channel_id", activeChannel.channel_id)
      .filter((pin) => channelMessages.some((message) => message.ts === pin.message_ts))
      .sort((a, b) => b.created - a.created)
      .slice(0, 20);
    const bookmarks = ss()
      .bookmarks.findBy("channel_id", activeChannel.channel_id)
      .sort(compareSlackBookmarks)
      .slice(0, 20);
    const views = ss()
      .views.all()
      .sort((a, b) => b.updated - a.updated || b.id - a.id);
    const homeViews = views.filter((view) => view.type === "home").slice(0, 20);
    const modalViews = views.filter((view) => view.type === "modal").slice(0, 20);

    const stats = `${ss().users.all().length} users, ${channels.length} conversations, ${ss().messages.all().length} messages, ${ss().views.all().length} views`;
    const body = [
      renderConversationSelector(channels, activeChannel.channel_id),
      section(
        `Messages In ${channelLabel(activeChannel)}`,
        { type: "text", text: `${activeChannel.topic.value || "No topic set"} - ${stats}` },
        renderMessagesTable(
            messages,
            users,
            "No messages yet. Post one with chat.postMessage or an incoming webhook.", store.now,
          ),
      ),
      section("Threads", renderMessagesTable(threads, users, "No thread replies for this conversation.", store.now)),
      section(
        "Ephemeral",
        renderEphemeralTable(ephemeralMessages, users, "No ephemeral messages for this conversation.", store.now),
      ),
      section(
        "Scheduled",
        renderScheduledTable(scheduledMessages, users, "No scheduled messages for this conversation."),
      ),
      section("Pins", renderPinsTable(pins, channelMessages, users, "No pins for this conversation.")),
      section("Bookmarks", renderBookmarksTable(bookmarks, "No bookmarks for this conversation.")),
      section("App Home", renderViewsTable(homeViews, users, "No App Home views have been published.")),
      section("Modals", renderViewsTable(modalViews, users, "No modal views have been opened.")),
    ];
    return body;
  }

  function renderConversationSelector(channels: SlackChannel[], activeChannelId: string): Block {
    const rows = channels.map((ch) => [
      ch.channel_id === activeChannelId ? badge("active", "granted") : "",
      linkCell(`/?tab=messages&channel=${encodeURIComponent(ch.channel_id)}`, channelLabel(ch)),
      channelKind(ch),
      String(ch.num_members),
      ch.is_archived ? badge("archived", "denied") : badge("open", "granted"),
    ]);
    return section(
      "Conversations",
      table(["", "Name", "Type", "Members", "State"], rows, "No conversations in the emulator store."),
    );
  }

  function renderChannelsView(users: Map<string, string>): Block[] {
    const channels = sortedChannels(ss().channels.all());
    const conversations = channels.filter((channel) => !channel.is_im && !channel.is_mpim);
    const dms = channels.filter((channel) => channel.is_im || channel.is_mpim);

    return [
      section(
        "Channels",
        table(
          ["ID", "Name", "Type", "Members", "Topic", "Purpose", "State"],
          conversations.map((ch) => [
            ch.channel_id,
            linkCell(`/?tab=messages&channel=${encodeURIComponent(ch.channel_id)}`, channelLabel(ch)),
            channelKind(ch),
            ch.members.map((member) => userLabel(users, member)).join(", "),
            ch.topic.value,
            ch.purpose.value,
            ch.is_archived ? badge("archived", "denied") : badge("open", "granted"),
          ]),
          "No channels in the emulator store.",
        ),
      ),
      section(
        "Direct Messages",
        table(
          ["ID", "Name", "Type", "Members", "Open State"],
          dms.map((ch) => [
            ch.channel_id,
            linkCell(`/?tab=messages&channel=${encodeURIComponent(ch.channel_id)}`, channelLabel(ch)),
            channelKind(ch),
            ch.members.map((member) => userLabel(users, member)).join(", "),
            openStateLabel(ch, users),
          ]),
          "No DMs or MPIMs in the emulator store.",
        ),
      ),
    ];
  }

  function renderFilesView(users: Map<string, string>): Block[] {
    const files = ss()
      .files.all()
      .sort((a, b) => b.created - a.created || b.id - a.id);
    const sessions = ss()
      .fileUploadSessions.all()
      .filter((session) => !session.completed)
      .sort((a, b) => b.id - a.id);

    return [
      section(
        "Files",
        table(
          ["ID", "Title", "User", "Channels", "Size", "State", "Created"],
          files.map((file) => [
            file.file_id,
            file.title || file.name,
            userLabel(users, file.user),
            [...file.channels, ...file.groups, ...file.ims].join(", "),
            String(file.size),
            file.deleted ? badge("deleted", "denied") : badge("available", "granted"),
            new Date(file.created * 1000).toISOString(),
          ]),
          "No completed files in the emulator store.",
        ),
      ),
      section(
        "Pending Uploads",
        table(
          ["File ID", "Filename", "Title", "Length", "Uploaded", "Completed"],
          sessions.map((session) => [
            session.file_id,
            session.filename,
            session.title,
            String(session.length),
            session.uploaded ? badge("uploaded", "granted") : badge("pending"),
            session.completed ? badge("complete", "granted") : badge("pending"),
          ]),
          "No pending external upload sessions.",
        ),
      ),
    ];
  }

  function renderViewsView(users: Map<string, string>): Block[] {
    const views = ss()
      .views.all()
      .sort((a, b) => b.updated - a.updated || b.id - a.id);
    const homeViews = views.filter((view) => view.type === "home");
    const modalViews = views.filter((view) => view.type === "modal");
    const triggers = ss()
      .viewTriggers.all()
      .sort((a, b) => b.expires_at - a.expires_at || b.id - a.id);

    return [
      section("App Home", renderViewsTable(homeViews, users, "No App Home views have been published.")),
      section("Modals", renderViewsTable(modalViews, users, "No modal views have been opened.")),
      section("Trigger IDs", renderTriggerTable(triggers, users, store.now)),
    ];
  }

  function renderAuthView(): Block[] {
    const subscriptions = webhooks.getSubscriptions("slack");
    return [
      section("OAuth Apps", renderOAuthAppsTable(ss().oauthApps.all())),
      section("Installations", renderInstallationsTable(ss().installations.all())),
      section("Tokens", renderTokensTable(ss().tokens.all())),
      section("Incoming Webhooks", renderIncomingWebhooksTable(ss().incomingWebhooks.all())),
      section("Event Subscriptions", renderSubscriptionsTable(subscriptions)),
    ];
  }

  function renderEventsView(): Block[] {
    const subscriptions = webhooks.getSubscriptions("slack");
    const slackHookIds = new Set(subscriptions.map((subscription) => subscription.id));
    const allDeliveries = webhooks
      .getDeliveries()
      .filter((delivery) => slackHookIds.has(delivery.hook_id))
      .sort((a, b) => b.id - a.id);
    const deliveries = allDeliveries.slice(0, 100);
    const failed = allDeliveries.filter((delivery) => !delivery.success).slice(0, 100);

    return [
      section("Event Subscriptions", renderSubscriptionsTable(subscriptions)),
      section(
        "Event Deliveries",
        renderDeliveriesTable(deliveries, subscriptions, "No Slack event deliveries yet."),
      ),
      section("Last Errors", renderDeliveriesTable(failed, subscriptions, "No failed Slack event deliveries.")),
    ];
  }
}

function renderMessagesTable(messages: SlackMessage[], users: Map<string, string>, empty: string, clockNow: () => number = Date.now): Block {
  return table(
    ["Time", "User", "Message", "Reactions", "TS"],
    messages.map((msg) => {
      const isBot = msg.subtype === "bot_message";
      const richBadge =
        msg.text.length === 0 && ((msg.blocks?.length ?? 0) > 0 || (msg.attachments?.length ?? 0) > 0)
          ? [badge("rich", "granted")]
          : [];
      const threadBadge =
        msg.reply_count > 0
          ? [badge(`${msg.reply_count} ${msg.reply_count === 1 ? "reply" : "replies"}`, "requested")]
          : [];
      const fileBadge = msg.files?.length
        ? [badge(`${msg.files.length} ${msg.files.length === 1 ? "file" : "files"}`, "granted")]
        : [];
      const threadIndicator = msg.thread_ts && msg.thread_ts !== msg.ts ? [badge("thread", "denied")] : [];
      return [
        timeAgo(msg.created_at, clockNow),
        isBot ? [userLabel(users, msg.user), badge("bot", "granted")] : userLabel(users, msg.user),
        [...threadIndicator, richMessagePreview(msg), ...richBadge, ...fileBadge, ...threadBadge],
        renderReactionBadges(msg.reactions),
        msg.ts,
      ];
    }),
    empty,
  );
}

function renderEphemeralTable(messages: SlackEphemeralMessage[], users: Map<string, string>, empty: string, clockNow: () => number = Date.now): Block {
  return table(
    ["Time", "Target", "Message", "TS"],
    messages.map((msg) => [
      timeAgo(msg.created_at, clockNow),
      [userLabel(users, msg.target_user), badge("ephemeral", "requested")],
      richMessagePreview(msg),
      msg.ts,
    ]),
    empty,
  );
}

function renderScheduledTable(messages: SlackScheduledMessage[], users: Map<string, string>, empty: string): Block {
  return table(
    ["Post At", "User", "Message", "ID"],
    messages.map((msg) => [
      new Date(msg.post_at * 1000).toISOString(),
      userLabel(users, msg.user),
      richMessagePreview(msg),
      msg.scheduled_message_id,
    ]),
    empty,
  );
}

function renderPinsTable(
  pins: SlackPin[],
  channelMessages: SlackMessage[],
  users: Map<string, string>,
  empty: string,
): Block {
  return table(
    ["Created", "Creator", "Message", "TS"],
    pins.map((pin) => {
      const message = channelMessages.find((candidate) => candidate.ts === pin.message_ts);
      return [
        new Date(pin.created * 1000).toISOString(),
        userLabel(users, pin.created_by),
        message ? richMessagePreview(message) : pin.message_ts,
        pin.message_ts,
      ];
    }),
    empty,
  );
}

function renderBookmarksTable(bookmarks: SlackBookmark[], empty: string): Block {
  return table(
    ["Title", "Type", "Link", "Rank"],
    bookmarks.map((bookmark) => [
      bookmark.title,
      bookmark.type,
      bookmark.link,
      bookmark.rank,
    ]),
    empty,
  );
}

function renderViewsTable(views: SlackView[], users: Map<string, string>, empty: string): Block {
  return table(
    ["ID", "Type", "User", "App", "Preview", "Hash", "Root", "Previous"],
    views.map((view) => [
      view.view_id,
      view.type === "home" ? badge("app home", "granted") : badge("modal", "requested"),
      userLabel(users, view.user_id),
      view.app_id,
      viewPreview(view),
      view.hash,
      view.root_view_id,
      view.previous_view_id ?? "",
    ]),
    empty,
  );
}

function renderTriggerTable(triggers: SlackViewTrigger[], users: Map<string, string>, clockNow: () => number = Date.now): Block {
  const now = Math.floor(clockNow() / 1000);
  return table(
    ["Trigger ID", "User", "App", "View", "Expires", "State"],
    triggers.map((trigger) => [
      trigger.trigger_id,
      userLabel(users, trigger.user_id),
      trigger.app_id,
      trigger.view_id ?? "",
      new Date(trigger.expires_at * 1000).toISOString(),
      trigger.used
        ? badge("used", "denied")
        : trigger.expires_at <= now
          ? badge("expired", "denied")
          : badge("active", "granted"),
    ]),
    "No local trigger ids have been generated.",
  );
}

function renderOAuthAppsTable(apps: SlackOAuthApp[]): Block {
  return table(
    ["App ID", "Client ID", "Name", "Bot", "Scopes", "User Scopes"],
    apps.map((app) => [
      app.app_id ?? "",
      app.client_id,
      app.name,
      app.bot_id ?? app.bot_name ?? "",
      scopePreview(app.scopes),
      scopePreview(app.user_scopes),
    ]),
    "No OAuth apps are configured.",
  );
}

function renderInstallationsTable(installations: SlackInstallation[]): Block {
  return table(
    ["Installation", "App", "Team", "Bot User", "Installer", "Scopes"],
    installations.map((installation) => [
      installation.installation_id,
      installation.app_id,
      installation.team_id,
      installation.bot_user_id,
      installation.installer_user_id,
      scopePreview(installation.scopes),
    ]),
    "No OAuth installations have been recorded.",
  );
}

function renderTokensTable(tokens: SlackToken[]): Block {
  return table(
    ["Token", "Type", "Team", "User", "App", "Bot", "Scopes"],
    tokens.map((token) => [
      maskToken(token.token),
      token.token_type,
      token.team_id,
      token.user_id,
      token.app_id ?? "",
      token.bot_id ?? token.bot_user_id ?? "",
      scopePreview(token.scopes),
    ]),
    "No Slack token records have been seeded or exchanged.",
  );
}

function renderIncomingWebhooksTable(webhooks: SlackIncomingWebhook[]): Block {
  return table(
    ["Token", "Team", "Bot", "Default Channel", "Label", "URL"],
    webhooks.map((webhook) => [
      maskToken(webhook.token),
      webhook.team_id,
      webhook.bot_id,
      webhook.default_channel,
      webhook.label,
      webhook.url,
    ]),
    "No incoming webhooks are configured.",
  );
}

function renderSubscriptionsTable(subscriptions: WebhookSubscription[]): Block {
  return table(
    ["ID", "URL", "Events", "State"],
    subscriptions.map((subscription) => [
      String(subscription.id),
      subscription.url,
      subscription.events.join(", "),
      subscription.active ? badge("active", "granted") : badge("inactive", "denied"),
    ]),
    "No Slack event subscriptions are registered.",
  );
}

function renderDeliveriesTable(
  deliveries: WebhookDelivery[],
  subscriptions: WebhookSubscription[],
  empty: string,
): Block {
  const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  return table(
    ["ID", "Event", "Hook", "URL", "Status", "Duration", "Delivered"],
    deliveries.map((delivery) => {
      const subscription = subscriptionsById.get(delivery.hook_id);
      return [
        String(delivery.id),
        delivery.event,
        String(delivery.hook_id),
        subscription?.url ?? "",
        delivery.success
          ? badge(String(delivery.status_code ?? "ok"), "granted")
          : badge(String(delivery.status_code ?? "failed"), "denied"),
        delivery.duration === null ? "" : `${delivery.duration}ms`,
        delivery.delivered_at,
      ];
    }),
    empty,
  );
}
