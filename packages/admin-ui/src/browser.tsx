import { StyleProvider } from "@ant-design/cssinjs"
import {
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  CameraOutlined,
  CheckOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  HistoryOutlined,
  MacCommandOutlined,
  MoonOutlined,
  ReloadOutlined,
  SearchOutlined,
  SunOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons"
import type { ThemeConfig } from "antd"
import {
  App,
  Avatar,
  Badge,
  Button,
  Card,
  ConfigProvider,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Result,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from "antd"
import type { ReactNode } from "react"
import { Component, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createApi } from "./api.js"
import { brandCatalogUrl, brandFor } from "./brand.js"
import { ErrorNotice, useResource } from "./components.js"
import {
  ClockView,
  FaultsView,
  JournalView,
  LatencyView,
  Overview,
  RoutesView,
  SnapshotsView,
  TimelineView,
} from "./controls.js"
import { ManualView } from "./manual.js"
import { Members } from "./members.js"
import type { AdminApiConfig, AdminConfig, Api, Manifest, MembersConfig, Panel } from "./model.js"
import { errorMessage } from "./model.js"
import { SqlExplorer } from "./sql.js"
import { StateExplorer } from "./state.js"

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) }
  }
  override render() {
    return this.state.error ? (
      <Result
        status="error"
        title="The admin could not render"
        subTitle={this.state.error}
        extra={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
      />
    ) : (
      this.props.children
    )
  }
}

const remember = (key: string, value?: string): string | null => {
  try {
    if (value !== undefined) sessionStorage.setItem(key, value)
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

type PaletteCommand = {
  id: string
  label: string
  detail: string
  keywords: string
  icon: ReactNode
  run(): void
}

function CommandPalette({
  open,
  onClose,
  commands,
  popupHost,
  dark,
}: {
  open: boolean
  onClose(): void
  commands: readonly PaletteCommand[]
  popupHost: HTMLElement
  dark: boolean
}) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const input = useRef<import("antd").InputRef>(null)
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const visible = commands.filter((command) => {
    const haystack = `${command.label} ${command.detail} ${command.keywords}`.toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  const selected = visible[Math.min(active, Math.max(0, visible.length - 1))]
  const colors = dark
    ? { surface: "#171d26", border: "#343e4c", selected: "rgba(91,156,246,.16)" }
    : { surface: "#ffffff", border: "#d4dae3", selected: "#eaf2ff" }
  useEffect(() => {
    if (!open) return
    setQuery("")
    setActive(0)
    requestAnimationFrame(() => input.current?.focus())
  }, [open])
  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return
    command.run()
    onClose()
  }
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={640}
      centered={false}
      getContainer={() => popupHost}
      transitionName=""
      maskTransitionName=""
      styles={{
        body: {
          padding: 0,
          overflow: "hidden",
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
        },
      }}
      afterOpenChange={(isOpen) => isOpen && input.current?.focus()}
    >
      <Input
        ref={input}
        variant="borderless"
        size="large"
        prefix={<SearchOutlined />}
        suffix={<Typography.Text keyboard>esc</Typography.Text>}
        aria-label="Admin command palette"
        placeholder="Jump to an emulator or screen…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            const delta = event.key === "ArrowDown" ? 1 : -1
            setActive((index) =>
              visible.length === 0 ? 0 : (index + delta + visible.length) % visible.length,
            )
          } else if (event.key === "Enter") {
            event.preventDefault()
            choose(selected)
          }
        }}
        style={{ padding: "16px 18px", fontSize: 16 }}
      />
      <div style={{ borderTop: `1px solid ${colors.border}` }}>
        <div style={{ maxHeight: 440, overflowY: "auto", padding: 8 }} role="listbox">
          {visible.length === 0 ? (
            <Result
              status="info"
              title="No commands found"
              subTitle="Try an emulator or screen name."
            />
          ) : (
            visible.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(command)}
                style={{
                  width: "100%",
                  border: 0,
                  borderRadius: 8,
                  padding: "11px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  textAlign: "left",
                  cursor: "pointer",
                  color: "inherit",
                  background: index === active ? colors.selected : "transparent",
                }}
              >
                <span style={{ color: "var(--ant-color-primary)", fontSize: 17 }}>
                  {command.icon}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text strong style={{ display: "block" }}>
                    {command.label}
                  </Typography.Text>
                  <Typography.Text type="secondary" ellipsis style={{ display: "block" }}>
                    {command.detail}
                  </Typography.Text>
                </span>
                {index === active && (
                  <CheckOutlined style={{ color: "var(--ant-color-primary)" }} />
                )}
              </button>
            ))
          )}
        </div>
        <Flex
          justify="space-between"
          style={{ borderTop: `1px solid ${colors.border}`, padding: "9px 14px" }}
        >
          <Typography.Text type="secondary">↑↓ Navigate · ↵ Open</Typography.Text>
          <Typography.Text type="secondary">Emulators and admin screens</Typography.Text>
        </Flex>
      </div>
    </Modal>
  )
}

const shellTheme = (dark: boolean): ThemeConfig => {
  const palette = dark
    ? {
        canvas: "#0b0f14",
        surface: "#11161d",
        elevated: "#171d26",
        border: "#252d38",
        borderStrong: "#343e4c",
        text: "#edf2f7",
        textMuted: "#9aa6b5",
        primary: "#5b9cf6",
        selected: "rgba(91, 156, 246, 0.16)",
        hover: "rgba(255, 255, 255, 0.055)",
      }
    : {
        canvas: "#f5f7fa",
        surface: "#ffffff",
        elevated: "#ffffff",
        border: "#e4e8ee",
        borderStrong: "#d4dae3",
        text: "#172033",
        textMuted: "#667085",
        primary: "#2563d8",
        selected: "#eaf2ff",
        hover: "#f3f6fa",
      }

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      motion: false,
      colorPrimary: palette.primary,
      colorInfo: palette.primary,
      colorBgBase: palette.canvas,
      colorBgLayout: palette.canvas,
      colorBgContainer: palette.surface,
      colorBgElevated: palette.elevated,
      colorBorder: palette.borderStrong,
      colorBorderSecondary: palette.border,
      colorText: palette.text,
      colorTextSecondary: palette.textMuted,
      borderRadius: 8,
      borderRadiusLG: 12,
      controlHeight: 38,
      fontSize: 14,
      boxShadowSecondary: dark
        ? "0 18px 48px rgba(0, 0, 0, 0.42)"
        : "0 18px 48px rgba(16, 24, 40, 0.14)",
    },
    components: {
      Layout: {
        bodyBg: palette.canvas,
        headerBg: palette.surface,
        siderBg: palette.surface,
        triggerBg: palette.surface,
        triggerColor: palette.textMuted,
        lightSiderBg: palette.surface,
        lightTriggerBg: palette.surface,
        lightTriggerColor: palette.textMuted,
      },
      Menu: {
        itemBg: palette.surface,
        itemColor: palette.textMuted,
        itemHoverBg: palette.hover,
        itemHoverColor: palette.text,
        itemSelectedBg: palette.selected,
        itemSelectedColor: palette.primary,
        itemBorderRadius: 8,
        itemHeight: 42,
        darkItemBg: palette.surface,
        darkSubMenuItemBg: palette.surface,
        darkItemColor: palette.textMuted,
        darkItemHoverBg: palette.hover,
        darkItemHoverColor: palette.text,
        darkItemSelectedBg: palette.selected,
        darkItemSelectedColor: dark ? "#9dc2fa" : palette.primary,
      },
      Card: {
        headerBg: "transparent",
      },
      Table: {
        headerBg: dark ? "#171d25" : "#f7f9fc",
        headerColor: palette.text,
        rowHoverBg: palette.hover,
        borderColor: palette.border,
      },
    },
  }
}

function Vendor({ config, service }: { config: AdminConfig; service: string }) {
  const [brand, setBrand] = useState<ReturnType<typeof brandFor>>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(brandCatalogUrl(config.brandsUrl, location.href), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((catalog: unknown) => {
        if (!controller.signal.aborted) setBrand(brandFor(service, catalog))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [config.brandsUrl, service])
  if (!brand) return null
  return (
    <Space wrap size="small">
      {brand.logo && <Avatar size={20} src={brand.logo} shape="square" />}
      <Typography.Text title={brand.description}>{brand.vendor}</Typography.Text>
      {brand.website && (
        <Typography.Link href={brand.website} target="_blank" rel="noopener noreferrer">
          Website
        </Typography.Link>
      )}
      {brand.guide && (
        <Typography.Link href={brand.guide} target="_blank" rel="noopener noreferrer">
          Docs
        </Typography.Link>
      )}
      {brand.docs && (
        <Typography.Link href={brand.docs} target="_blank" rel="noopener noreferrer">
          API
        </Typography.Link>
      )}
    </Space>
  )
}

function CustomPanel({ panel, api }: { panel: Panel; api: Api }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const root = host.current
    if (!root) return
    root.innerHTML = panel.html
    let dispose: unknown
    try {
      if (panel.script) dispose = new Function("root", "api", panel.script)(root, api) as unknown
    } catch (error) {
      setError(errorMessage(error))
    }
    return () => {
      if (typeof dispose === "function") dispose()
      root.replaceChildren()
    }
  }, [panel, api])
  return (
    <Card title={panel.title}>
      <Flex vertical gap="middle">
        {panel.description && <Typography.Paragraph>{panel.description}</Typography.Paragraph>}
        <ErrorNotice error={error} />
        <div ref={host} />
      </Flex>
    </Card>
  )
}

function Workspace({
  host,
  config,
  popupHost,
}: {
  host: HTMLElement
  config: AdminConfig
  popupHost: HTMLElement
}) {
  const params = useMemo(() => new URL(location.href).searchParams, [])
  const apiConfigs = useMemo<readonly AdminApiConfig[]>(
    () =>
      config.apis?.length
        ? config.apis
        : [{ ...config, id: config.service, label: config.service }],
    [config],
  )
  const [apiId, setApiId] = useState(
    params.get("emulator") || params.get("mock") || apiConfigs[0]?.id || config.service,
  )
  const apiConfig = apiConfigs.find((candidate) => candidate.id === apiId) ??
    apiConfigs[0] ?? { ...config, id: config.service, label: config.service }
  const [namespace, setNamespace] = useState(params.get("namespace") || "default")
  const [key, setKey] = useState(params.get("admin_key") ?? remember("mockingbird-admin-key") ?? "")
  const [draftKey, setDraftKey] = useState(key)
  const [view, setView] = useState(location.hash.slice(1) || "overview")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [narrow, setNarrow] = useState(host.clientWidth < 760)
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight)
  const [collapsed, setCollapsed] = useState(false)
  const [dark, setDark] = useState(
    remember("mockingbird-admin-theme") === "dark" ||
      (remember("mockingbird-admin-theme") === null &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  )
  const adminTheme = useMemo(() => shellTheme(dark), [dark])
  const shellBorder = dark ? "#252d38" : "#e4e8ee"
  const shellSurface = dark ? "#11161d" : "#ffffff"
  const api = useMemo(
    () => createApi(apiConfig, fetch, namespace, key),
    [apiConfig, namespace, key],
  )
  const manifest = useResource<Manifest>(api, "/ui/manifest", 0, false)
  const namespaces = useResource<{ namespaces: string[] }>(api, "/namespaces", revision)
  useEffect(() => {
    const root = host.getRootNode()
    const viewport = root instanceof ShadowRoot ? root.host : host
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0) return
      setNarrow(entry.contentRect.width < 760)
      setViewportHeight(root instanceof ShadowRoot ? entry.contentRect.height : window.innerHeight)
    })
    observer.observe(viewport)
    const resize = () => {
      if (!(root instanceof ShadowRoot)) setViewportHeight(window.innerHeight)
    }
    window.addEventListener("resize", resize)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", resize)
    }
  }, [host])
  useEffect(() => {
    remember("mockingbird-admin-key", key)
    if (params.has("admin_key")) {
      const url = new URL(location.href)
      url.searchParams.delete("admin_key")
      history.replaceState(null, "", url.href)
    }
  }, [key, params])
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return
      event.preventDefault()
      // The docs host has its own command palette. Embedded admins own this shortcut at their
      // scoped host boundary, so one keypress can never open both palettes.
      event.stopPropagation()
      event.stopImmediatePropagation()
      setPaletteOpen(true)
    }
    document.addEventListener("keydown", open)
    return () => document.removeEventListener("keydown", open)
  }, [])
  const panelList = [...(manifest.data?.panels ?? []), ...(manifest.data?.extensions ?? [])]
  const standardRoutes = manifest.data?.standardRoutes ?? apiConfig.standardRoutes
  const hasSql = panelList.some((panel) => panel.kind === "sql")
  const coreNav = [
    { key: "overview", icon: <AppstoreOutlined />, label: "Overview" },
    {
      key: "manual",
      icon: <ThunderboltOutlined />,
      label: "Manual controls",
      keywords: "delay timeout loading retry error manual",
    },
    { key: "state", icon: <DatabaseOutlined />, label: "State" },
    { key: "clock", icon: <FieldTimeOutlined />, label: "Clock" },
    { key: "latency", icon: <DashboardOutlined />, label: "Latency" },
    { key: "faults", icon: <ThunderboltOutlined />, label: "Faults" },
    {
      key: "snapshots",
      icon: <CameraOutlined />,
      label: "Snapshot & restore",
      keywords: "snapshot snapshots restore rollback save import export backup",
    },
    { key: "journal", icon: <HistoryOutlined />, label: "Journal" },
    {
      key: "checkpoints",
      icon: <BranchesOutlined />,
      label: "Checkpoints",
      keywords: "checkpoint branch checkout history timeline rewind",
    },
    { key: "routes", icon: <ApiOutlined />, label: "Routes" },
  ]
  const nav = [
    ...coreNav.map(({ key, icon, label }) => ({ key, icon, label })),
    ...panelList.map((panel) => ({
      key: panel.id,
      icon: panel.kind === "sql" ? <TableOutlined /> : <AppstoreOutlined />,
      label: panel.title,
    })),
  ]
  const goTo = (nextApi: string, nextView: string) => {
    setApiId(nextApi)
    setView(nextView)
    const url = new URL(location.href)
    url.hash = nextView
    history.replaceState(null, "", url.href)
  }
  const paletteCommands: PaletteCommand[] = [
    ...apiConfigs.flatMap((candidate) =>
      coreNav.map((screen) => ({
        id: `${candidate.id}:${screen.key}`,
        label: `${candidate.label ?? candidate.service} · ${screen.label}`,
        detail:
          screen.key === "overview"
            ? `Switch to ${candidate.label ?? candidate.service}`
            : screen.key === "snapshots"
              ? `Restore a snapshot of ${candidate.label ?? candidate.service}: records, clock, faults and latency`
              : screen.key === "checkpoints"
                ? `Restore a checkpoint of ${candidate.label ?? candidate.service}. History, not a snapshot`
                : `Open ${screen.label.toLocaleLowerCase()} for ${candidate.label ?? candidate.service}`,
        keywords: `emulator service admin ${candidate.id} ${candidate.service} ${screen.key} ${"keywords" in screen ? screen.keywords : ""}`,
        icon: screen.icon,
        run: () => goTo(candidate.id, screen.key),
      })),
    ),
    ...panelList.map((panel) => ({
      id: `${apiConfig.id}:${panel.id}`,
      label: `${apiConfig.label ?? apiConfig.service} · ${panel.title}`,
      detail: panel.description ?? `Open ${panel.title} for the current emulator`,
      keywords: `extension panel ${apiConfig.id} ${panel.id} ${panel.kind ?? "panel"}`,
      icon: panel.kind === "sql" ? <TableOutlined /> : <AppstoreOutlined />,
      run: () => goTo(apiConfig.id, panel.id),
    })),
  ]
  const selected = nav.some((item) => item.key === view) ? view : "overview"
  let content: ReactNode
  const common = { api, revision }
  switch (selected) {
    case "overview":
      content = <Overview {...common} />
      break
    case "manual":
      content = <ManualView {...common} />
      break
    case "state":
      content = <StateExplorer {...common} sql={hasSql} />
      break
    case "clock":
      content = <ClockView {...common} />
      break
    case "latency":
      content = <LatencyView {...common} />
      break
    case "faults":
      content = <FaultsView {...common} />
      break
    case "snapshots":
      content = <SnapshotsView {...common} />
      break
    case "journal":
      content = <JournalView {...common} />
      break
    case "checkpoints":
      content = <TimelineView {...common} />
      break
    case "routes":
      content = <RoutesView {...common} standardRoutes={standardRoutes} />
      break
    default: {
      const panel = panelList.find((panel) => panel.id === selected)
      content =
        panel?.kind === "sql" ? (
          <SqlExplorer {...common} />
        ) : panel?.kind === "route" ? (
          <RoutesView
            {...common}
            standardRoutes={standardRoutes}
            initialRoute={panel.route}
            initialBody={panel.body}
            title={panel.title}
            {...(panel.description ? { description: panel.description } : {})}
          />
        ) : (
          panel && <CustomPanel panel={panel} api={api} />
        )
    }
  }
  return (
    <ConfigProvider
      getPopupContainer={() => popupHost}
      // Embedded browsers can pause animation frames; disposal must remain immediate.
      theme={adminTheme}
    >
      <App
        message={{ getContainer: () => popupHost }}
        notification={{ getContainer: () => popupHost }}
        style={{ minHeight: "100%" }}
      >
        <Layout style={{ minHeight: viewportHeight, background: adminTheme.token?.colorBgLayout }}>
          <Layout.Header
            style={{
              height: "auto",
              minHeight: 72,
              padding: narrow ? "14px 16px" : "16px 24px",
              lineHeight: "normal",
              background: shellSurface,
              borderBottom: `1px solid ${shellBorder}`,
              zIndex: 2,
            }}
          >
            <Flex gap="middle" wrap justify="space-between" align="center">
              <Flex vertical gap={4}>
                <Flex align="center" gap="small">
                  {apiConfigs.length > 1 ? (
                    <Select
                      aria-label="Emulator"
                      showSearch
                      optionFilterProp="label"
                      variant="borderless"
                      value={apiConfig.id}
                      onChange={(next) => goTo(next, "overview")}
                      popupMatchSelectWidth={240}
                      style={{
                        minWidth: 190,
                        fontSize: 20,
                        fontWeight: 650,
                        marginInlineStart: -11,
                      }}
                      options={apiConfigs.map((candidate) => ({
                        value: candidate.id,
                        label: candidate.label ?? candidate.service,
                      }))}
                    />
                  ) : (
                    <Typography.Title level={4} style={{ margin: 0, textTransform: "capitalize" }}>
                      {apiConfig.label ?? apiConfig.service}
                    </Typography.Title>
                  )}
                  <Tag style={{ margin: 0 }}>Admin</Tag>
                </Flex>
                <Vendor config={config} service={apiConfig.service} />
              </Flex>
              <Flex wrap gap="small" align="center">
                <Button icon={<MacCommandOutlined />} onClick={() => setPaletteOpen(true)}>
                  Jump <Typography.Text keyboard>⌘K</Typography.Text>
                </Button>
                <Select
                  aria-label="Namespace"
                  showSearch
                  optionFilterProp="label"
                  value={namespace}
                  onChange={setNamespace}
                  style={{ minWidth: 150 }}
                  options={[...new Set([namespace, ...(namespaces.data?.namespaces ?? [])])].map(
                    (name) => ({ value: name, label: name }),
                  )}
                />
                <Form
                  layout="inline"
                  onFinish={() => {
                    setKey(draftKey.trim())
                    setRevision((n) => n + 1)
                  }}
                >
                  <Space.Compact>
                    <Input.Password
                      aria-label="Admin key"
                      placeholder="Admin key"
                      value={draftKey}
                      onChange={(event) => setDraftKey(event.target.value)}
                      style={{ width: 180 }}
                    />
                    <Button htmlType="submit">Connect</Button>
                  </Space.Compact>
                </Form>
                <Button
                  icon={dark ? <SunOutlined /> : <MoonOutlined />}
                  aria-label={dark ? "Use light theme" : "Use dark theme"}
                  onClick={() => {
                    remember("mockingbird-admin-theme", dark ? "light" : "dark")
                    setDark(!dark)
                  }}
                />
                <Badge status="processing" text="Live" />
                <Button icon={<ReloadOutlined />} onClick={() => setRevision((n) => n + 1)}>
                  Refresh
                </Button>
              </Flex>
            </Flex>
          </Layout.Header>
          <Layout style={{ minWidth: 0 }}>
            <Layout.Sider
              theme={dark ? "dark" : "light"}
              width={208}
              collapsedWidth={64}
              collapsed={narrow || collapsed}
              collapsible={!narrow}
              onCollapse={setCollapsed}
              style={{
                background: shellSurface,
                borderInlineEnd: `1px solid ${shellBorder}`,
              }}
            >
              <Menu
                theme={dark ? "dark" : "light"}
                mode="inline"
                selectedKeys={[selected]}
                items={nav}
                style={{
                  background: "transparent",
                  borderInlineEnd: 0,
                  padding: narrow || collapsed ? "12px 6px" : "12px 10px",
                }}
                onClick={({ key: next }) => {
                  goTo(apiConfig.id, next)
                }}
              />
            </Layout.Sider>
            <Layout.Content
              style={{
                minWidth: 0,
                padding: narrow ? "20px 12px 36px" : "32px 28px 48px",
              }}
            >
              <Flex
                vertical
                gap="large"
                style={{ width: "100%", maxWidth: 1440, margin: "0 auto" }}
              >
                <ErrorNotice
                  error={manifest.error ?? namespaces.error}
                  retry={() => {
                    manifest.reload()
                    namespaces.reload()
                  }}
                />
                {manifest.loading ? (
                  <Spin tip="Loading administration…">
                    <div style={{ minHeight: 120 }} />
                  </Spin>
                ) : (
                  <div key={`${apiId}:${namespace}:${key}:${selected}`}>{content}</div>
                )}
              </Flex>
            </Layout.Content>
          </Layout>
        </Layout>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={paletteCommands}
          popupHost={popupHost}
          dark={dark}
        />
      </App>
    </ConfigProvider>
  )
}

/** Bundled once at build time, then executed inside the admin document's scoped environment. */
export function mount(host: HTMLElement | null, config: AdminConfig): void {
  mountRoot(host, (popupHost) => (
    <Workspace host={host as HTMLElement} config={config} popupHost={popupHost} />
  ))
}

export function mountMembers(host: HTMLElement | null, config: MembersConfig): void {
  mountRoot(host, (popupHost) => (
    <ConfigProvider
      getPopupContainer={() => popupHost}
      theme={{
        algorithm: config.dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { motion: false },
      }}
    >
      <App message={{ getContainer: () => popupHost }}>
        <Members config={config} />
      </App>
    </ConfigProvider>
  ))
}

function mountRoot(host: HTMLElement | null, render: (popupHost: HTMLElement) => ReactNode): void {
  if (!host) throw new Error("Admin root is missing")
  const styleRoot = host.getRootNode()
  const mountPoint = document.createElement("div")
  const popupHost = document.createElement("div")
  host.append(mountPoint, popupHost)
  const root = createRoot(mountPoint)
  root.render(
    <Boundary>
      <StyleProvider container={styleRoot instanceof ShadowRoot ? styleRoot : document.head}>
        {render(popupHost)}
      </StyleProvider>
    </Boundary>,
  )
  const dispose = () => root.unmount()
  document.addEventListener("mockingbird:unmount", dispose, { once: true })
  window.addEventListener("pagehide", dispose, { once: true })
}
