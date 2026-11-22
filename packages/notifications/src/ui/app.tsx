/**
 * The harness UI: the shared Mockingbird chrome (a page header with the view switch and status,
 * a filter row, the channel tabs, the timeline table and the inspector, all HeroUI) around the
 * four device skins, which imitate what the recipient sees and so keep their platforms' looks.
 *
 * Every element a test might look for has a `data-testid` from `../testids.ts`, and every element
 * that shows a notification carries its id, channel, service, recipient, sender and status as
 * `data-*` attributes. Every gesture (swipe, long press) also has a click or key equivalent.
 */

import {
  EmptyState,
  JsonView,
  KeyValueList,
  PageHeader,
  StatusChip,
} from "@crvouga/mockingbird-ui/react"
import { Bell, Display, ListUl, Sliders, Volume, VolumeXmark, Xmark } from "@gravity-ui/icons"
import {
  Alert,
  Button,
  Chip,
  Drawer,
  Label,
  ListBox,
  SearchField,
  Select,
  Switch,
  Table,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import {
  Component,
  type CSSProperties,
  createRef,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react"
import { CHANNELS, type Channel, type Notification } from "../model.js"
import { TEST_IDS, type TestId } from "../testids.js"
import { StoreProvider, useAttrs, useStore } from "./context.js"
import { ChatDevice } from "./device-chat.js"
import { EmailDevice } from "./device-email.js"
import { PushDevice } from "./device-push.js"
import { SmsDevice } from "./device-sms.js"
import {
  CHANNEL_LABEL,
  chatLabel,
  displaySender,
  formatPhone,
  isWhatsApp,
  serviceLabel,
  statusKind,
  timelineTime,
  tokenLabel,
} from "./format.js"
import { attachGestures, zoomOf } from "./gestures.js"
import { attachOpenLink } from "./open-link.js"
import { ROOT_CLASS } from "./skins.js"
import type { Store } from "./store.js"
import { type ChannelTab, TAB_LABELS, tabsFor } from "./tabs.js"
import type { PushSkin } from "./types.js"

const CHANNEL_COLOR = {
  sms: "success",
  push: "warning",
  email: "accent",
  chat: "default",
} as const satisfies Record<Channel, "success" | "warning" | "accent" | "default">

// ── Motion: list items glide to their new places ─────────────────────────────

/**
 * Animates elements with a stable `data-flip` key from where they were to where they are after a
 * redraw: measured before React touches the DOM, played after.
 */
class Flip extends Component<{
  enabled: boolean
  className: string
  hidden: boolean
  region: string
  id: string
  children: ReactNode
}> {
  ref = createRef<HTMLDivElement>()
  override getSnapshotBeforeUpdate(): Map<string, number> | null {
    const el = this.ref.current
    if (!this.props.enabled || !el || typeof el.animate !== "function") return null
    const before = new Map<string, number>()
    for (const node of el.querySelectorAll<HTMLElement>("[data-flip]"))
      before.set(node.dataset.flip ?? "", node.getBoundingClientRect().top)
    return before
  }
  override componentDidUpdate(
    _props: unknown,
    _state: unknown,
    before: Map<string, number> | null,
  ) {
    const el = this.ref.current
    if (!before || !el) return
    for (const node of el.querySelectorAll<HTMLElement>("[data-flip]")) {
      const top = before.get(node.dataset.flip ?? "")
      if (top === undefined) continue
      const dy = (top - node.getBoundingClientRect().top) / zoomOf(node)
      if (Math.abs(dy) < 1) continue
      node.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 380,
        easing: "cubic-bezier(.2,.9,.25,1)",
      })
    }
  }
  override render() {
    const { className, hidden, region, id, children } = this.props
    return (
      <div ref={this.ref} className={className} hidden={hidden} data-region={region} id={id}>
        {children}
      </div>
    )
  }
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

function SourceChips() {
  const store = useStore()
  return (
    <>
      {store.state.sources.map((s) => (
        <span
          key={s.name}
          title={s.error ?? s.url}
          data-testid={TEST_IDS.source}
          data-name={s.name}
          data-service={s.service ?? ""}
          data-ok={String(s.ok)}
          data-count={s.count}
        >
          <StatusChip status={s.ok ? "ok" : s.error ? "error" : "neutral"} dot>
            {s.service && s.name !== s.service
              ? `${s.name} · ${serviceLabel(s.service)}`
              : serviceLabel(s.name)}{" "}
            <b className="font-semibold">{s.count}</b>
          </StatusChip>
        </span>
      ))}
    </>
  )
}

function Toolbar({ heading }: { heading: boolean | "page" }) {
  const store = useStore()
  const { state, actions, handle, sound } = store
  const phone = store.frame.size === "phone"
  const namespaces = [...new Set([...state.namespaces, state.namespace])].sort()
  const moreId = `${useRef(`mbn-${Math.random().toString(36).slice(2, 8)}`).current}-more`
  const connection = (
    <span
      data-testid={TEST_IDS.connection}
      data-state={state.connected ? "live" : "reconnecting"}
      role="status"
    >
      <StatusChip status={state.connected ? "ok" : "warning"} dot>
        {state.connected ? "Live" : "Reconnecting"}
      </StatusChip>
    </span>
  )
  const viewSwitch = (
    <ToggleButtonGroup
      aria-label="View"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[state.view]}
      onSelectionChange={(keys) => {
        const [next] = [...keys]
        if (next === "devices" || next === "timeline") actions.setView(next)
      }}
    >
      <ToggleButton id="devices" data-testid={TEST_IDS.viewDevices}>
        <Display className="size-4" />
        Devices
      </ToggleButton>
      <ToggleButton id="timeline" data-testid={TEST_IDS.viewTimeline}>
        <ListUl className="size-4" />
        Timeline
        <span className="text-muted">{state.items.length}</span>
      </ToggleButton>
    </ToggleButtonGroup>
  )
  return (
    <div className="flex flex-none flex-col gap-3 px-4 pt-4 sm:px-6" data-testid={TEST_IDS.topbar}>
      {heading ? (
        <PageHeader
          level={heading === "page" ? 1 : 2}
          title={store.title()}
          description="Every text, push, email and chat message the app sent, as the recipient sees it."
          actions={
            <>
              {connection}
              {viewSwitch}
            </>
          }
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          aria-label="Filter notifications"
          value={state.search}
          onChange={actions.setSearch}
          className="min-w-0 flex-1 basis-48 sm:max-w-sm"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input
              data-testid={TEST_IDS.search}
              placeholder={phone ? "Filter notifications…" : "Filter by recipient, sender, text…"}
            />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        {heading ? null : connection}
        {phone ? (
          <Button
            isIconOnly
            variant="secondary"
            size="sm"
            data-testid={TEST_IDS.menu}
            aria-label="More options"
            aria-expanded={state.menu}
            aria-controls={moreId}
            onPress={actions.toggleMenu}
          >
            {state.menu ? <Xmark className="size-4" /> : <Sliders className="size-4" />}
          </Button>
        ) : null}
        <div
          id={moreId}
          className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${phone ? (state.menu ? "basis-full" : "hidden") : ""}`}
        >
          {heading ? null : viewSwitch}
          <Select
            aria-label="Namespace"
            selectedKey={state.namespace}
            onSelectionChange={(key) => key !== null && handle.setNamespace(String(key))}
            className="w-44"
            data-testid={TEST_IDS.namespace}
            data-value={state.namespace}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox aria-label="Namespaces">
                {namespaces.map((ns) => (
                  <ListBox.Item key={ns} id={ns} textValue={ns}>
                    {ns}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Switch
            isSelected={state.follow}
            onChange={actions.setFollow}
            data-testid={TEST_IDS.follow}
            aria-label="Follow new: jump each device to the newest arrival"
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>Follow new</Label>
            </Switch.Content>
          </Switch>
          <ToggleButton
            size="sm"
            isSelected={sound.enabled}
            onChange={(on) => handle.setSound(on)}
            data-testid={TEST_IDS.sound}
            aria-label="Sound: play alert sounds on arrivals"
          >
            {sound.enabled ? <Volume className="size-4" /> : <VolumeXmark className="size-4" />}
            Sound
          </ToggleButton>
        </div>
      </div>
      {state.sources.length ? (
        <div
          className={`flex flex-wrap items-center gap-1.5 ${phone && !state.menu ? "hidden" : ""}`}
        >
          <SourceChips />
        </div>
      ) : null}
    </div>
  )
}

function Notice() {
  const store = useStore()
  const { state } = store
  const failing = state.sources.filter((s) => s.error)
  if (state.discoveryError || failing.length)
    return (
      <div className="px-4 pt-3 sm:px-6" data-testid={TEST_IDS.notice} data-kind="error">
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {state.discoveryError ? "Fleet discovery failed" : "An emulator is not answering"}
            </Alert.Title>
            <Alert.Description className="break-words">
              {state.discoveryError ? `${state.discoveryError}. ` : ""}
              {failing.map((s, i) => (
                <span key={s.name}>
                  {i ? " · " : ""}
                  <b>{s.name}</b>: {s.error}
                </span>
              ))}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    )
  if (!state.sources.length)
    return (
      <div className="px-4 pt-3 sm:px-6" data-testid={TEST_IDS.notice} data-kind="empty">
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No messaging emulators found yet</Alert.Title>
            <Alert.Description>
              Start the fleet with twilio, resend, fcm, ses, sns, customerio, mailosaur, slack or
              cognito.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    )
  return null
}

// ── Channel tabs ─────────────────────────────────────────────────────────────

function ChannelTabs() {
  const store = useStore()
  const tabs = store.options.tabs === false ? [] : tabsFor(store.enabled, store.frame.compact)
  if (!tabs.length || store.state.view !== "devices") return null
  const current = store.tab()
  const compact = store.frame.compact
  return (
    <Tabs
      selectedKey={current}
      onSelectionChange={(key) => store.actions.selectTab(String(key) as ChannelTab)}
      className="flex-none px-4 pt-3 sm:px-6"
    >
      <Tabs.ListContainer className={compact ? "" : "w-fit max-w-full"}>
        <Tabs.List
          aria-label="Notification channels"
          data-testid={TEST_IDS.channelTabs}
          data-layout={compact ? "tabs" : "grid"}
          className={compact ? "w-full" : ""}
        >
          {tabs.map((value) => {
            const unread = value === "all" ? 0 : store.unreadIn(value)
            return (
              <Tabs.Tab
                key={value}
                id={value}
                data-testid={TEST_IDS.channelTab}
                data-value={value}
                data-unread={unread}
                className={compact ? "flex-1" : ""}
              >
                {TAB_LABELS[value]}
                {unread && value !== current ? (
                  <Chip
                    size="sm"
                    color="accent"
                    variant="primary"
                    className="ml-1.5"
                    data-testid={TEST_IDS.channelTabUnread}
                    aria-label={`${unread} unread`}
                  >
                    {unread}
                  </Chip>
                ) : null}
              </Tabs.Tab>
            )
          })}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  )
}

// ── Device columns ───────────────────────────────────────────────────────────

const RECIPIENT: Record<Channel, { label: string; testId: TestId }> = {
  sms: { label: "Phone", testId: TEST_IDS.smsRecipient },
  push: { label: "Device", testId: TEST_IDS.pushRecipient },
  email: { label: "Mailbox", testId: TEST_IDS.emailRecipient },
  chat: { label: "Channel", testId: TEST_IDS.chatRecipient },
}

const COUNT: Record<Channel, TestId> = {
  sms: TEST_IDS.smsUnreadCount,
  push: TEST_IDS.pushUnreadCount,
  email: TEST_IDS.emailUnreadCount,
  chat: TEST_IDS.chatUnreadCount,
}

const HEADING: Record<Channel, string> = {
  sms: "Text messages",
  push: "Push",
  email: "Email",
  chat: "Chat",
}

function RecipientSelect({ channel }: { channel: Channel }) {
  const store = useStore()
  const list = store.recipients(channel)
  const current = store.state[channel].to
  const { label, testId } = RECIPIENT[channel]
  const format = (to: string) =>
    channel === "sms"
      ? formatPhone(to)
      : channel === "chat"
        ? chatLabel(to)
        : channel === "push"
          ? tokenLabel(to, list.find((r) => r.to === to)?.platform)
          : to
  return (
    <Select
      aria-label={label}
      placeholder="No recipients yet"
      selectedKey={current && list.some((r) => r.to === current) ? current : null}
      onSelectionChange={(key) => key !== null && store.actions.setRecipient(channel, String(key))}
      isDisabled={!list.length}
      className="w-full min-w-0"
      data-testid={testId}
      data-value={current ?? ""}
    >
      <Select.Trigger className="gap-2">
        <span className="flex-none text-xs text-muted">{label}</span>
        <Select.Value className="min-w-0 flex-1 truncate text-left">
          {({ selectedText, isPlaceholder, defaultChildren }) =>
            isPlaceholder ? defaultChildren : selectedText
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={label}>
          {list.map((r) => (
            <ListBox.Item key={r.to} id={r.to} textValue={format(r.to)}>
              <span className="min-w-0 flex-1 truncate">{format(r.to)}</span>
              <span className="text-xs text-muted">{r.count}</span>
              {r.unread ? (
                <span className="size-2 rounded-full bg-accent" role="img" aria-label="unread" />
              ) : null}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

function SkinSwitch() {
  const store = useStore()
  return (
    <ToggleButtonGroup
      aria-label="Phone"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[store.state.push.skin]}
      onSelectionChange={(keys) => {
        const [next] = [...keys]
        if (next) store.actions.setSkin(String(next) as PushSkin)
      }}
    >
      {(["auto", "ios", "android"] as const).map((skin) => (
        <ToggleButton key={skin} id={skin} data-testid={TEST_IDS.pushSkin} data-value={skin}>
          {skin === "auto" ? "Auto" : skin === "ios" ? "iOS" : "Android"}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

/**
 * The strip above a device: its name and unread count, then the recipient picker. The same two
 * fixed rows on every device, so the frames below start at the same height whatever controls a
 * device adds.
 */
function DeviceHead({ channel }: { channel: Channel }) {
  const store = useStore()
  const unread = store.unreadIn(channel)
  return (
    <div className="device-head grid h-[76px] w-full flex-none grid-rows-[32px_36px] gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden">
        <h2 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-foreground">
          {HEADING[channel]}
          {unread ? (
            <Chip
              size="sm"
              color="accent"
              variant="primary"
              data-testid={COUNT[channel]}
              data-count={unread}
            >
              {unread}
            </Chip>
          ) : null}
        </h2>
        {channel === "push" ? <SkinSwitch /> : null}
      </div>
      <RecipientSelect channel={channel} />
    </div>
  )
}

const DEVICES: Record<Channel, () => ReactNode> = {
  sms: SmsDevice,
  push: PushDevice,
  email: EmailDevice,
  chat: ChatDevice,
}

function Devices({ uid }: { uid: string }) {
  const store = useStore()
  const shown = CHANNELS.filter(store.shown)
  const visible = store.state.view === "devices"
  return (
    <section
      className={`devices ${shown.length === 1 ? "solo" : ""}`}
      data-region="devices"
      hidden={!visible}
    >
      {CHANNELS.map((channel) => {
        const Device = DEVICES[channel]
        const on = store.shown(channel)
        return (
          <Flip
            key={channel}
            enabled={store.animate()}
            className={`device-col ${channel === "email" || channel === "chat" ? "wide" : ""} ${channel === "chat" ? "chat-col" : ""}`}
            hidden={!on}
            region={`col-${channel}`}
            id={`${uid}-panel-${channel}`}
          >
            {visible && on ? (
              <>
                <DeviceHead channel={channel} />
                <Device />
              </>
            ) : null}
          </Flip>
        )
      })}
    </section>
  )
}

// ── Timeline + inspector ─────────────────────────────────────────────────────

function Timeline() {
  const store = useStore()
  const attrs = useAttrs()
  const items = store.visible()
  const now = store.nowMs()
  if (store.state.view !== "timeline") return null
  if (!items.length)
    return (
      <div
        className="px-4 py-4 sm:px-6"
        data-region="timeline"
        data-testid={TEST_IDS.timelineEmpty}
      >
        <EmptyState
          icon={<Bell />}
          title="Nothing sent yet"
          description={
            <>
              Nothing sent in namespace <b>{store.state.namespace}</b> yet.
            </>
          }
        />
      </div>
    )
  return (
    <div className="px-4 py-4 sm:px-6" data-region="timeline">
      <Table>
        <Table.ScrollContainer>
          <Table.Content
            aria-label="Timeline"
            data-testid={TEST_IDS.timeline}
            onRowAction={(key) => store.actions.inspect(String(key))}
          >
            <Table.Header>
              <Table.Column isRowHeader>Time</Table.Column>
              <Table.Column>Channel</Table.Column>
              <Table.Column className="max-sm:hidden">Source</Table.Column>
              <Table.Column>To</Table.Column>
              <Table.Column className="max-md:hidden">From</Table.Column>
              <Table.Column className="max-sm:hidden">Content</Table.Column>
              <Table.Column className="max-md:hidden">Status</Table.Column>
            </Table.Header>
            <Table.Body>
              {items.map((n) => (
                <Table.Row
                  key={n.id}
                  id={n.id}
                  data-testid={TEST_IDS.timelineRow}
                  {...attrs(n)}
                  className="cursor-pointer"
                >
                  <Table.Cell data-col="time" className="whitespace-nowrap font-mono text-xs">
                    {timelineTime(n.createdAt, now)}
                  </Table.Cell>
                  <Table.Cell data-col="channel">
                    <Chip size="sm" variant="soft" color={CHANNEL_COLOR[n.channel]}>
                      {isWhatsApp(n) ? "WhatsApp" : CHANNEL_LABEL[n.channel]}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell data-col="source" className="text-xs text-muted max-sm:hidden">
                    {serviceLabel(n.service)}
                    {n.source !== n.service ? ` · ${n.source}` : ""}
                  </Table.Cell>
                  <Table.Cell data-col="to" className="max-w-56 truncate font-mono text-xs">
                    {n.channel === "sms"
                      ? formatPhone(n.to)
                      : n.channel === "chat"
                        ? chatLabel(n.to)
                        : n.to.length > 28
                          ? `${n.to.slice(0, 26)}…`
                          : n.to}
                  </Table.Cell>
                  <Table.Cell data-col="from" className="max-md:hidden">
                    {displaySender(n)}
                  </Table.Cell>
                  <Table.Cell data-col="content" className="max-w-[32rem] text-muted max-sm:hidden">
                    {n.email ? (
                      <b className="font-semibold text-foreground">{n.email.subject} — </b>
                    ) : n.push?.title ? (
                      <b className="font-semibold text-foreground">{n.push.title} — </b>
                    ) : null}
                    {n.channel === "email" || n.channel === "chat"
                      ? n.preview.slice(0, 120)
                      : (n.sms?.body ?? n.push?.body ?? n.preview)}
                  </Table.Cell>
                  <Table.Cell data-col="status" className="max-md:hidden">
                    {n.status ? (
                      <StatusChip status={statusKind(n.status)}>{n.status}</StatusChip>
                    ) : null}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  )
}

function InspectorBody({ n }: { n: Notification }) {
  const { raw, ...normalized } = n
  const field = (key: string, label: string, value: string) => ({
    id: key,
    label,
    mono: true,
    value: (
      <span data-testid={TEST_IDS.inspectorField} data-field={key}>
        {value}
      </span>
    ),
  })
  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          field("id", "Id", n.id),
          field("providerId", "Provider id", n.providerId),
          field("service", "Service", `${n.service} (${n.source})`),
          field("namespace", "Namespace", n.namespace),
          field("to", "To", n.to),
          field(
            "from",
            "From",
            n.from.name ? `${n.from.name} <${n.from.address}>` : n.from.address,
          ),
          field("createdAt", "Created", n.createdAt),
          field("status", "Status", n.status ?? "—"),
        ]}
      />
      <div data-testid={TEST_IDS.inspectorJson}>
        <JsonView value={{ ...normalized, raw }} label="" copyable={false} wrap />
      </div>
    </div>
  )
}

function Inspector() {
  const store = useStore()
  const attrs = useAttrs()
  const n = store.state.inspect ? store.state.items.find((x) => x.id === store.state.inspect) : null
  return (
    <Drawer.Backdrop
      isOpen={Boolean(n)}
      onOpenChange={(open) => {
        if (!open) store.actions.inspect(null)
      }}
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog
          className="sm:w-[560px]"
          aria-label="Notification"
          data-testid={TEST_IDS.inspector}
          {...(n ? attrs(n) : {})}
        >
          {n ? (
            <>
              <Drawer.Header>
                <Drawer.Heading data-testid={TEST_IDS.inspectorTitle} className="truncate">
                  {isWhatsApp(n) ? "WHATSAPP" : n.channel.toUpperCase()} ·{" "}
                  {n.email?.subject ?? n.push?.title ?? n.preview.slice(0, 60)}
                </Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body>
                <InspectorBody n={n} />
              </Drawer.Body>
              <Drawer.Footer>
                <Button
                  variant="secondary"
                  data-testid={TEST_IDS.inspectorClose}
                  onPress={() => store.actions.inspect(null)}
                >
                  Close
                </Button>
                <Button
                  data-testid={TEST_IDS.inspectorShowOnDevice}
                  onPress={() => store.actions.showOnDevice(n.id)}
                >
                  Show on device
                </Button>
              </Drawer.Footer>
            </>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

export type NotificationsAppProps = {
  store: Store
  /**
   * Show the title as a page header. Default true (a section heading); `"page"` makes it the page's
   * `h1`, as every screen in an app shell has.
   */
  heading?: boolean | "page"
}

/** The whole harness UI for one store. `createApp` and the dashboard render it. */
export function NotificationsApp({ store, heading = true }: NotificationsAppProps) {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const root = useRef<HTMLDivElement>(null)
  const uid = useRef(`mbn-${Math.random().toString(36).slice(2, 8)}`).current
  const { state, frame, options } = store

  // Gestures and the devices' own controls: one set of delegated listeners on the root.
  useEffect(() => {
    if (!root.current) return
    const detach = [
      attachGestures(root.current, store),
      attachOpenLink(root.current, store.options.openLink),
    ]
    return () => {
      for (const each of detach) each()
    }
  }, [store])

  // Follow the host element, not the window: embedded in a side panel the harness is narrow on a
  // wide screen.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const refit = () => {
      if (store.measure(el.clientWidth)) store.emit()
    }
    refit()
    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", refit)
      return () => window.removeEventListener("resize", refit)
    }
    const observer = new ResizeObserver(refit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [store])

  // After each drawing: the one-shot motion cues are spent, `ready` resolves once the ready state
  // is on screen, and a notification `show` asked for scrolls into view.
  useEffect(() => {
    store.cues.sms = null
    store.cues.email = false
    store.cues.wake = false
    store.drawnReady()
    const target = store.takeScrollTarget()
    if (target)
      root.current
        ?.querySelector(`[data-region="devices"] [data-notification-id="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ block: "nearest" })
  })

  const chrome = options.chrome !== false
  return (
    <StoreProvider store={store}>
      <div
        ref={root}
        className={`${ROOT_CLASS} ${options.embedded ? "embedded flex h-full min-h-0 flex-col overflow-hidden" : "flex min-h-full flex-col"} relative bg-background text-foreground`}
        data-testid={TEST_IDS.app}
        data-ready={String(state.ready)}
        data-view={state.view}
        data-namespace={state.namespace}
        data-count={state.items.length}
        data-version={state.version}
        data-connected={String(state.connected)}
        data-sound={String(store.sound.enabled)}
        data-motion={store.motion()}
        data-layout={frame.compact ? "tabs" : "grid"}
        data-tab={store.tab()}
        data-size={frame.size}
        style={
          {
            "--mbn-scale": String(frame.scale),
            "--mbn-fit": String(frame.fit),
          } as CSSProperties
        }
      >
        {chrome ? <Toolbar heading={heading} /> : null}
        {chrome ? <Notice /> : null}
        <ChannelTabs />
        <div
          className={`mbn-scroll flex min-h-0 flex-col ${options.embedded || frame.size === "phone" ? "flex-1 overflow-auto" : ""}`}
          data-region="scroll"
        >
          <Devices uid={uid} />
          <Timeline />
        </div>
        <Inspector />
      </div>
    </StoreProvider>
  )
}
