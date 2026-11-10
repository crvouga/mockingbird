/**
 * Every `data-testid` the harness UI renders, and selector helpers for browser tests.
 *
 * Elements that show one notification also carry its fields as attributes, so a test can narrow by
 * what it knows instead of by position:
 *
 *   data-notification-id  data-channel  data-service  data-source  data-to  data-from
 *   data-status  data-created-at  data-unread ("true" | "false")
 *
 * The UI root (`TEST_IDS.app`) reports its state the same way: `data-ready` ("true" once the first
 * read finished), `data-view`, `data-namespace`, `data-count`, `data-version`, `data-connected`,
 * `data-sound` and `data-motion`.
 *
 * This module has no dependencies, so Playwright, Cypress or WebdriverIO specs can import it.
 */
export const TEST_IDS = {
  /** The UI root. */
  app: "notifications-app",

  // ── Top bar ─────────────────────────────────────────────────────────────────
  topbar: "topbar",
  /** `<select>` of namespaces. */
  namespace: "namespace",
  /** Filter `<input>` (recipient, sender, text). */
  search: "search",
  /** View tabs; `aria-pressed="true"` on the active one. */
  viewDevices: "view-devices",
  viewTimeline: "view-timeline",
  /** "Follow new" checkbox. */
  follow: "follow",
  /** Sound on/off button; `aria-pressed`. */
  sound: "sound-toggle",
  /** Live stream indicator; `data-state="live" | "reconnecting"`. */
  connection: "connection",
  /** One pill per emulator; `data-name`, `data-service`, `data-ok`, `data-count`. */
  source: "source",
  /** Discovery or emulator errors, or the "no emulators" hint; `data-kind="error" | "empty"`. */
  notice: "notice",
  /** Bottom-left message after an action, e.g. "Conversation archived." */
  toast: "toast",
  toastUndo: "toast-undo",

  // ── SMS: Messages ────────────────────────────────────────────────────────────
  /** The phone; `data-screen="threads" | "conversation"`, `data-recipient`, `data-thread`. */
  smsDevice: "sms-device",
  /** Phone number `<select>`; option values are E.164 numbers. */
  smsRecipient: "sms-recipient",
  /** Unread SMS badge next to the column title (absent when 0). */
  smsUnreadCount: "sms-unread-count",
  /** One conversation in the list; `data-from` (the sender address), `data-unread`, `data-pinned`, `data-muted`. */
  smsThread: "sms-thread",
  smsThreadName: "sms-thread-name",
  smsThreadPreview: "sms-thread-preview",
  smsThreadTime: "sms-thread-time",
  smsThreadUnread: "sms-thread-unread",
  /** Swipe actions behind a thread (also reachable with the keyboard: focus the thread, press Delete). */
  smsThreadDelete: "sms-thread-delete",
  smsThreadMute: "sms-thread-mute",
  smsThreadPin: "sms-thread-pin",
  smsThreadToggleUnread: "sms-thread-toggle-unread",
  /** Shown when the phone has no messages. */
  smsEmpty: "sms-empty",
  /** An open conversation; `data-from`. */
  smsConversation: "sms-conversation",
  smsConversationTitle: "sms-conversation-title",
  smsBack: "sms-back",
  /** One message; carries the notification attributes plus `data-code` when it holds a one-time code. */
  smsBubble: "sms-bubble",
  smsBubbleMedia: "sms-bubble-media",
  /** The time revealed by swiping the conversation left. */
  smsBubbleTime: "sms-bubble-time",
  /** A reaction added with the long-press menu; `data-tapback`. */
  smsTapback: "sms-tapback",
  /** Centered date stamp between messages. */
  smsTimestamp: "sms-timestamp",
  /** One-time code suggestion above the keyboard; `data-code`. */
  smsCode: "sms-code",
  /** Long-press menu on a bubble. */
  smsMenu: "sms-menu",
  smsMenuCopy: "sms-menu-copy",
  /** One tapback in the menu; `data-tapback="heart" | "like" | "dislike" | "laugh" | "emphasize" | "question"`. */
  smsMenuTapback: "sms-menu-tapback",

  // ── Push: lock screen (iOS) / shade (Android) ───────────────────────────────
  /** The phone; `data-skin="ios" | "android"`, `data-recipient`, `data-platform`. */
  pushDevice: "push-device",
  /** Device token `<select>`. */
  pushRecipient: "push-recipient",
  /** Skin buttons; `data-value`, `aria-pressed`. */
  pushSkin: "push-skin",
  pushUnreadCount: "push-unread-count",
  /** One notification; notification attributes plus `data-expanded`, `data-platform`, `data-app`, `data-stacked`. */
  pushNotification: "push-notification",
  pushNotificationApp: "push-notification-app",
  pushNotificationTitle: "push-notification-title",
  pushNotificationBody: "push-notification-body",
  pushNotificationTime: "push-notification-time",
  pushNotificationImage: "push-notification-image",
  /** The `data` payload, shown when expanded. */
  pushNotificationData: "push-notification-data",
  /** Service, status, badge and sound, shown when expanded. */
  pushNotificationMeta: "push-notification-meta",
  /** iOS: a group of notifications from one app; `data-app`, `data-count`, `data-open`. */
  pushGroup: "push-group",
  /** iOS: "N more notifications" under a collapsed group (click to open it); `data-count`. */
  pushGroupMore: "push-group-more",
  /** iOS: "Show less" on an open group. */
  pushGroupCollapse: "push-group-collapse",
  /** iOS: swipe-left actions. */
  pushClear: "push-clear",
  pushOptions: "push-options",
  /** iOS long-press preview; Android long-press settings. */
  pushPreview: "push-preview",
  pushSettings: "push-settings",
  /** Android "Clear all". */
  pushClearAll: "push-clear-all",
  pushEmpty: "push-empty",

  // ── Email: web mail ─────────────────────────────────────────────────────────
  /** The browser window; `data-screen="inbox" | "message"`, `data-recipient`. */
  emailDevice: "email-device",
  /** Mailbox `<select>`; option values are lower-case addresses. */
  emailRecipient: "email-recipient",
  emailUnreadCount: "email-unread-count",
  /** One inbox row; notification attributes plus `data-starred`. */
  emailRow: "email-row",
  emailRowFrom: "email-row-from",
  emailRowSubject: "email-row-subject",
  emailRowSnippet: "email-row-snippet",
  emailRowDate: "email-row-date",
  emailRowService: "email-row-service",
  emailRowAttachment: "email-row-attachment",
  emailRowStar: "email-row-star",
  /** Hover actions on a row. */
  emailRowArchive: "email-row-archive",
  emailRowDelete: "email-row-delete",
  emailRowToggleRead: "email-row-toggle-read",
  emailRefresh: "email-refresh",
  emailEmpty: "email-empty",
  /** The open message; notification attributes. */
  emailOpen: "email-open",
  emailBack: "email-back",
  emailArchive: "email-archive",
  emailDelete: "email-delete",
  emailMarkUnread: "email-mark-unread",
  emailSubject: "email-subject",
  emailFromName: "email-from-name",
  emailFromAddress: "email-from-address",
  /** "to me, …" line; click to toggle the details. */
  emailTo: "email-to",
  emailDate: "email-date",
  emailDetails: "email-details",
  /** One row of the details; `data-field="from" | "to" | "cc" | "bcc" | "reply-to" | "date" | "subject" | "mailed-by" | "message-id"`. */
  emailDetail: "email-detail",
  /** The HTML body `<iframe>` (same origin: use `frameLocator`). */
  emailBody: "email-body",
  /** The plain-text body when there is no HTML. */
  emailText: "email-text",
  emailAttachments: "email-attachments",
  /** One attachment; `data-filename`, `data-content-type`, `data-size`. */
  emailAttachment: "email-attachment",

  // ── Timeline + inspector ────────────────────────────────────────────────────
  timeline: "timeline",
  /** One row; notification attributes. Click it to inspect. */
  timelineRow: "timeline-row",
  timelineEmpty: "timeline-empty",
  /** The JSON inspector; notification attributes. Opened by clicking a timeline row or double-clicking any notification. */
  inspector: "inspector",
  inspectorTitle: "inspector-title",
  inspectorClose: "inspector-close",
  inspectorShowOnDevice: "inspector-show-on-device",
  /** One normalized field; `data-field`. */
  inspectorField: "inspector-field",
  /** The full record, normalized fields plus `raw`, as JSON text. */
  inspectorJson: "inspector-json",
} as const

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS]

const attr = (value: string) => JSON.stringify(value)

/** CSS selectors for the harness UI. Each one works with `page.locator()` or `querySelector`. */
export const selectors = {
  /** `[data-testid="…"]` */
  testId: (id: TestId) => `[data-testid=${attr(id)}]`,
  /** The ready UI root: wait for this before asserting. */
  ready: () => `[data-testid=${attr(TEST_IDS.app)}][data-ready="true"]`,
  /** Any element showing this notification (bubble, thread, card, row, open email, timeline row). */
  notification: (id: string) => `[data-notification-id=${attr(id)}]`,
  /** A message bubble, optionally from one sender. */
  smsBubble: (filter: { from?: string; id?: string } = {}) =>
    `[data-testid=${attr(TEST_IDS.smsBubble)}]${filter.from ? `[data-from=${attr(filter.from)}]` : ""}${filter.id ? `[data-notification-id=${attr(filter.id)}]` : ""}`,
  /** A conversation in the Messages list. */
  smsThread: (from: string) => `[data-testid=${attr(TEST_IDS.smsThread)}][data-from=${attr(from)}]`,
  /** A push notification card, optionally by id. */
  pushNotification: (id?: string) =>
    `[data-testid=${attr(TEST_IDS.pushNotification)}]${id ? `[data-notification-id=${attr(id)}]` : ""}`,
  /** An inbox row, optionally by id. */
  emailRow: (id?: string) =>
    `[data-testid=${attr(TEST_IDS.emailRow)}]${id ? `[data-notification-id=${attr(id)}]` : ""}`,
  /** A timeline row, optionally by id. */
  timelineRow: (id?: string) =>
    `[data-testid=${attr(TEST_IDS.timelineRow)}]${id ? `[data-notification-id=${attr(id)}]` : ""}`,
}
