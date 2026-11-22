// biome-ignore-all lint/a11y/useSemanticElements: the skins imitate a phone's own notification cards, with ARIA roles on the elements that draw them
// biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: app icons are named for screen readers
/**
 * Push notifications as a phone shows them: the iOS lock screen (grouped by app, swipe for
 * Options and Clear, long-press to preview) or the Android notification shade (tap to expand,
 * swipe to dismiss, long-press for the app's settings). A device skin: the platform's own look
 * (`skins.ts`), no HeroUI inside.
 */
import type { Notification } from "../model.js"
import { TEST_IDS } from "../testids.js"
import { Glyph, useAttrs, useStore } from "./context.js"
import { StatusBar } from "./device-sms.js"
import {
  APP,
  ago,
  androidAgo,
  clock,
  colorFor,
  initials,
  serviceLabel,
  shortClock,
} from "./format.js"
import { icons } from "./icons.js"
import { groupKey } from "./store.js"

function PushData({ n }: { n: Notification }) {
  const data = n.push?.data ?? {}
  if (!Object.keys(data).length) return null
  return (
    <div className="note-data" data-testid={TEST_IDS.pushNotificationData}>
      {JSON.stringify(data, null, 2)}
    </div>
  )
}

function PushMeta({ n }: { n: Notification }) {
  const badge = n.push?.badge
  return (
    <div className="note-meta" data-testid={TEST_IDS.pushNotificationMeta}>
      {serviceLabel(n.service)} · {n.status ?? "accepted"}
      {badge !== null && badge !== undefined ? ` · badge ${badge}` : ""}
      {n.push?.sound ? ` · sound ${n.push.sound}` : ""}
    </div>
  )
}

const usePushAttrs = () => {
  const attrs = useAttrs()
  return (n: Notification, extra: Record<string, string | boolean> = {}) => ({
    ...attrs(n),
    "data-testid": TEST_IDS.pushNotification,
    "data-platform": n.push?.platform ?? "unknown",
    "data-app": n.push?.app ?? "App",
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`data-${k}`, String(v)])),
  })
}

function IosCard({
  n,
  expanded,
  stacked = false,
  top = false,
}: {
  n: Notification
  expanded: boolean
  stacked?: boolean
  top?: boolean
}) {
  const store = useStore()
  const pushAttrs = usePushAttrs()
  const p = n.push
  const app = p?.app ?? "App"
  const now = store.nowMs()
  return (
    <div
      className={`ios-note swipe-card ${expanded ? "expanded" : ""} ${store.state.arrived.has(n.id) ? "arrive" : ""}`}
      data-action="push-toggle"
      data-id={n.id}
      {...pushAttrs(n, { expanded, stacked })}
      {...(top ? { "data-group-top": "true" } : {})}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-longpress="ios-note"
    >
      <span
        className="app-icon"
        style={{ background: colorFor(app, APP) }}
        data-testid={TEST_IDS.pushNotificationApp}
        aria-label={app}
      >
        {initials(app).slice(0, 1)}
      </span>
      <div className="content">
        <div className="line1">
          <span className="title" data-testid={TEST_IDS.pushNotificationTitle}>
            {p?.title ?? app}
          </span>
          <span className="time" data-testid={TEST_IDS.pushNotificationTime}>
            {ago(n.createdAt, now)}
          </span>
        </div>
        <div className="body" data-testid={TEST_IDS.pushNotificationBody}>
          {p?.body ?? ""}
        </div>
        {expanded && p?.imageUrl ? (
          <img
            className="hero"
            src={p.imageUrl}
            alt=""
            data-testid={TEST_IDS.pushNotificationImage}
          />
        ) : null}
        {expanded ? (
          <>
            <PushData n={n} />
            <PushMeta n={n} />
          </>
        ) : null}
      </div>
      {!expanded && p?.imageUrl ? (
        <img
          className="thumb"
          src={p.imageUrl}
          alt=""
          data-testid={TEST_IDS.pushNotificationImage}
        />
      ) : null}
    </div>
  )
}

/** A lock-screen card with the swipe-left actions behind it. */
function IosNote({
  n,
  stacked = false,
  hidden = false,
  top = false,
}: {
  n: Notification
  stacked?: boolean
  hidden?: boolean
  top?: boolean
}) {
  const store = useStore()
  return (
    <div
      className="swipe ios-swipe"
      data-swipe="ios-note"
      data-id={n.id}
      data-flip={`note:${n.id}`}
      hidden={hidden}
    >
      <div className="swipe-actions">
        <button
          type="button"
          data-action="push-options"
          data-id={n.id}
          data-testid={TEST_IDS.pushOptions}
        >
          Options
        </button>
        <button
          type="button"
          data-action="push-clear"
          data-id={n.id}
          data-testid={TEST_IDS.pushClear}
        >
          Clear
        </button>
      </div>
      <IosCard n={n} expanded={store.state.push.expanded === n.id} stacked={stacked} top={top} />
    </div>
  )
}

/** iOS Notification Center groups each app's notifications into a stack. */
function IosGroups({ to, items }: { to: string; items: Notification[] }) {
  const store = useStore()
  const order: string[] = []
  const groups = new Map<string, Notification[]>()
  for (const n of items) {
    const app = n.push?.app ?? "App"
    if (!groups.has(app)) order.push(app)
    groups.set(app, [...(groups.get(app) ?? []), n])
  }
  return (
    <>
      {order.map((app) => {
        const list = groups.get(app) ?? []
        const first = list[0]
        if (!first) return null
        if (list.length === 1) return <IosNote key={first.id} n={first} />
        const key = groupKey(to, app)
        const rest = list.length - 1
        if (store.local.openGroups.has(key))
          return (
            <div
              key={`group:${app}`}
              className="push-group"
              data-testid={TEST_IDS.pushGroup}
              data-app={app}
              data-count={list.length}
              data-open="true"
              data-flip={`group:${app}`}
            >
              <div className="group-head">
                <h3>{app}</h3>
                <button
                  type="button"
                  data-action="group-collapse"
                  data-key={key}
                  data-testid={TEST_IDS.pushGroupCollapse}
                >
                  Show less
                </button>
                <button
                  type="button"
                  className="x"
                  data-action="group-clear"
                  data-key={key}
                  data-app={app}
                  aria-label={`Clear ${app} notifications`}
                >
                  <Glyph svg={icons.close(14)} />
                </button>
              </div>
              {list.map((n) => (
                <IosNote key={n.id} n={n} />
              ))}
            </div>
          )
        return (
          <div
            key={`group:${app}`}
            className="push-group"
            data-testid={TEST_IDS.pushGroup}
            data-app={app}
            data-count={list.length}
            data-open="false"
            data-flip={`group:${app}`}
          >
            <IosNote n={first} top />
            <button
              type="button"
              className="stack-layers"
              data-action="group-open"
              data-key={key}
              data-testid={TEST_IDS.pushGroupMore}
              data-count={rest}
              aria-label={`Show ${rest} more notification${rest === 1 ? "" : "s"}`}
            >
              <div className="ios-stack-more" />
              {rest > 1 ? <div className="ios-stack-more" /> : null}
              <div className="center-label" style={{ fontSize: 13, marginTop: 6 }}>
                {rest} more notification{rest === 1 ? "" : "s"}
              </div>
            </button>
            {list.slice(1).map((n) => (
              <IosNote key={n.id} n={n} stacked hidden />
            ))}
          </div>
        )
      })}
    </>
  )
}

function AndroidNote({ n }: { n: Notification }) {
  const store = useStore()
  const pushAttrs = usePushAttrs()
  const p = n.push
  const expanded = store.state.push.expanded === n.id
  const app = p?.app ?? "App"
  const settings = store.state.push.settings === n.id
  const silent = store.local.silent.has(app)
  return (
    <div
      className={`a-note ${expanded ? "expanded" : ""} ${store.state.arrived.has(n.id) ? "arrive" : ""}`}
      data-action="push-toggle"
      data-id={n.id}
      {...pushAttrs(n, { expanded })}
      data-swipe="a-note"
      data-longpress="a-note"
      data-flip={`note:${n.id}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
    >
      <span className="a-icon" style={{ background: colorFor(app, APP) }} aria-hidden="true">
        {initials(app).slice(0, 1)}
      </span>
      <div className="a-main">
        <div className="a-head">
          <span data-testid={TEST_IDS.pushNotificationApp}>{app}</span>
          <span>•</span>
          <span data-testid={TEST_IDS.pushNotificationTime}>
            {androidAgo(n.createdAt, store.nowMs())}
          </span>
          {silent ? (
            <span>
              <Glyph svg={icons.bellSlash(12)} />
            </span>
          ) : null}
          <span className="chev">
            <Glyph svg={expanded ? icons.collapse() : icons.expand()} />
          </span>
        </div>
        {p?.title ? (
          <div className="a-title" data-testid={TEST_IDS.pushNotificationTitle}>
            {p.title}
          </div>
        ) : null}
        <div className="a-body" data-testid={TEST_IDS.pushNotificationBody}>
          {p?.body ?? ""}
        </div>
        {expanded && p?.imageUrl ? (
          <img
            className="big-picture"
            src={p.imageUrl}
            alt=""
            data-testid={TEST_IDS.pushNotificationImage}
          />
        ) : null}
        {expanded ? (
          <>
            <PushData n={n} />
            <PushMeta n={n} />
          </>
        ) : null}
        {settings ? (
          <div className="a-settings" data-testid={TEST_IDS.pushSettings} data-app={app}>
            <button
              type="button"
              className="opt"
              data-action="push-alerting"
              data-app={app}
              data-value="alerting"
              aria-pressed={!silent}
            >
              <Glyph svg={icons.bell()} />
              <span>
                Default<small>May ring or vibrate based on device settings</small>
              </span>
            </button>
            <button
              type="button"
              className="opt"
              data-action="push-alerting"
              data-app={app}
              data-value="silent"
              aria-pressed={silent}
            >
              <Glyph svg={icons.bellSlash(18)} />
              <span>
                Silent<small>No sound or vibration</small>
              </span>
            </button>
            <div className="row">
              <button type="button" data-action="close-overlay">
                Turn off notifications
              </button>
              <button type="button" data-action="close-overlay">
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {!expanded && p?.imageUrl ? (
        <img
          className="large-icon"
          src={p.imageUrl}
          alt=""
          data-testid={TEST_IDS.pushNotificationImage}
        />
      ) : null}
    </div>
  )
}

/** The phone for `state.push.to`, wearing the iOS or Android skin. */
export function PushDevice() {
  const store = useStore()
  const to = store.state.push.to
  const items = store.pushItems()
  const platform = items[0]?.push?.platform ?? "unknown"
  const skin = store.pushSkin()
  const now = new Date(store.nowMs())
  const wake = store.cues.wake && store.animate()
  const deviceAttrs = {
    "data-testid": TEST_IDS.pushDevice,
    "data-skin": skin,
    "data-recipient": to ?? "",
    "data-platform": platform,
  }
  if (skin === "android")
    return (
      <div className="pixel mbn-skin" {...deviceAttrs}>
        <div className="screen">
          <div className="punch" />
          <div className="shade">
            <div className="sb">
              <span>{shortClock(now)}</span>
              <span className="icons">
                <Glyph svg={icons.androidWifi()} />
                <Glyph svg={icons.androidSignal()} />
                <Glyph svg={icons.androidBattery()} />
              </span>
            </div>
            <div className="qs-head">
              <span>
                {now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
              </span>
              <Glyph svg={icons.gear()} />
            </div>
            <div className="qs">
              <div className="tile on">
                <Glyph svg={icons.androidWifi()} />
                <div>
                  Internet<small>Mockingbird</small>
                </div>
              </div>
              <div className="tile">
                <Glyph svg={icons.bell()} />
                <div>
                  Do Not Disturb<small>Off</small>
                </div>
              </div>
              <div className="tile">
                <Glyph svg={icons.androidBattery()} />
                <div>
                  Battery Saver<small>Off</small>
                </div>
              </div>
              <div className="tile">
                <Glyph svg={icons.lock()} />
                <div>
                  Screen lock<small>On</small>
                </div>
              </div>
            </div>
            <div className="qs-bright" />
            <div className="shade-list" role="list">
              {items.length ? (
                items.map((n) => <AndroidNote key={n.id} n={n} />)
              ) : (
                <div className="shade-empty" data-testid={TEST_IDS.pushEmpty}>
                  No notifications
                </div>
              )}
            </div>
            {items.length ? (
              <div className="shade-actions">
                <button type="button" data-action="close-overlay">
                  Manage
                </button>
                <button
                  type="button"
                  data-action="push-clear-all"
                  data-testid={TEST_IDS.pushClearAll}
                >
                  Clear all
                </button>
              </div>
            ) : null}
            <div className="gesture" />
          </div>
        </div>
      </div>
    )
  const preview = store.state.push.preview
    ? items.find((n) => n.id === store.state.push.preview)
    : null
  return (
    <div className="iphone mbn-skin" {...deviceAttrs}>
      <div className="screen">
        <div className="island" />
        <StatusBar light />
        <div className={`lock ${wake ? "wake" : ""}`}>
          <div className="padlock">
            <Glyph svg={icons.padlock()} />
          </div>
          <div className="date">
            {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </div>
          <div className="clock">{clock(now).replace(/\s?[AP]M$/i, "")}</div>
          <div className="lock-stack" role="list">
            {items.length && to ? (
              <>
                <div className="center-label">Notification Center</div>
                <IosGroups to={to} items={items} />
              </>
            ) : (
              <div className="lock-empty" data-testid={TEST_IDS.pushEmpty}>
                {to ? "No Older Notifications" : "No push notifications yet"}
              </div>
            )}
          </div>
          <div className="lock-buttons">
            <span>
              <Glyph svg={icons.flashlight()} />
            </span>
            <span>
              <Glyph svg={icons.camera()} />
            </span>
          </div>
          {preview ? (
            <div
              className="ios-overlay dark"
              data-action="close-overlay"
              data-testid={TEST_IDS.pushPreview}
              data-notification-id={preview.id}
              role="dialog"
              aria-label="Notification preview"
            >
              <IosCard n={preview} expanded />
              <div className="ios-menu" role="menu">
                <button type="button" role="menuitem" data-action="push-clear" data-id={preview.id}>
                  Clear
                </button>
                <button type="button" role="menuitem" data-action="close-overlay">
                  Options
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="home-indicator light" />
      </div>
    </div>
  )
}
