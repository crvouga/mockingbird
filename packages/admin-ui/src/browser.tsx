import {
  AppShell,
  ErrorState,
  LoadingState,
  MockingbirdProvider,
  StatusChip,
  THEME_STORAGE_KEY,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import {
  AbbrApi,
  ArrowRotateRight,
  BranchesRight,
  Camera,
  Clock,
  ClockArrowRotateLeft,
  Database,
  Hand,
  LayoutCellsLarge,
  LayoutHeaderCells,
  Puzzle,
  Speedometer,
  ThunderboltFill,
} from "@gravity-ui/icons"
import { Alert, Avatar, Button, Form, Kbd, Link, ListBox } from "@heroui/react"
import type { ReactNode } from "react"
import { Component, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createApi } from "./api.js"
import { brandCatalogUrl, brandFor } from "./brand.js"
import {
  Choose,
  Chrome,
  ErrorNotice,
  SearchSelect,
  Section,
  TextInput,
  useResource,
} from "./components.js"
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
import {
  type AdminEnvironment,
  RuntimeProvider,
  resolveEnvironment,
  useRuntime,
} from "./environment.js"
import { ManualView } from "./manual.js"
import { Members } from "./members.js"
import type { AdminApiConfig, AdminConfig, Api, Manifest, MembersConfig, Panel } from "./model.js"
import { errorMessage } from "./model.js"
import { CommandPalette, type PaletteCommand } from "./palette.js"
import { SqlExplorer } from "./sql.js"
import { StateExplorer } from "./state.js"

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) }
  }
  override render() {
    return this.state.error ? (
      <div className="p-6">
        <ErrorState
          title="The admin could not render"
          error={this.state.error}
          retryLabel="Try again"
          onRetry={() => this.setState({ error: null })}
        />
      </div>
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

type Theme = "light" | "dark"

/**
 * Light or dark, as the visitor chose it with the shared theme switch (`mb:theme`, the docs
 * site's key) or else as the system prefers. The admin pins its own subtree to the result, so it
 * themes correctly inside a Shadow DOM, where the page's `<html>` classes do not reach.
 */
function useResolvedTheme(pinned?: Theme): Theme {
  const resolve = (): Theme => {
    if (pinned) return pinned
    let stored: string | null = null
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {}
    if (stored === "light" || stored === "dark") return stored
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  const [theme, setTheme] = useState(resolve)
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolve only reads `pinned`.
  useEffect(() => {
    const update = () => setTheme(resolve())
    update()
    if (pinned) return
    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    media?.addEventListener("change", update)
    // ThemeSwitch stores the choice and applies it to <html>; follow it from there.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    })
    window.addEventListener("storage", update)
    return () => {
      media?.removeEventListener("change", update)
      observer.disconnect()
      window.removeEventListener("storage", update)
    }
  }, [pinned])
  return theme
}

function Vendor({ config, service }: { config: AdminConfig; service: string }) {
  const runtime = useRuntime()
  const [brand, setBrand] = useState<ReturnType<typeof brandFor>>(null)
  useEffect(() => {
    const controller = new AbortController()
    runtime
      .fetch(brandCatalogUrl(config.brandsUrl, runtime.href()), {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((catalog: unknown) => {
        if (!controller.signal.aborted) setBrand(brandFor(service, catalog))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [config.brandsUrl, service, runtime])
  if (!brand) return null
  const links = [
    ["Website", brand.website],
    ["Docs", brand.guide],
    ["API", brand.docs],
  ] as const
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {brand.logo && (
        <Avatar size="sm" className="size-5 rounded-sm">
          <Avatar.Image src={brand.logo} alt="" />
          <Avatar.Fallback>{brand.vendor.slice(0, 1)}</Avatar.Fallback>
        </Avatar>
      )}
      <span className="text-foreground" title={brand.description}>
        {brand.vendor}
      </span>
      {links.map(([label, href]) =>
        href ? (
          <Link key={label} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </Link>
        ) : null,
      )}
    </div>
  )
}

function CustomPanel({
  panel,
  api,
  apiConfig,
}: {
  panel: Panel
  api: Api
  apiConfig: AdminApiConfig
}) {
  const runtime = useRuntime()
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [inactive, setInactive] = useState(false)
  useEffect(() => {
    const root = host.current
    if (!root) return
    root.innerHTML = panel.html
    setError(null)
    setInactive(false)
    let dispose: unknown
    if (panel.script) {
      let run: ReturnType<typeof runtime.panelScript>
      let compiled = true
      try {
        run = runtime.panelScript(panel, apiConfig)
      } catch (error) {
        compiled = false
        // A Content Security Policy without 'unsafe-eval' refuses to compile a string.
        if (error instanceof EvalError) setInactive(true)
        else setError(errorMessage(error))
      }
      if (compiled && !run) setInactive(true)
      try {
        if (run) dispose = run(root, api)
      } catch (error) {
        setError(errorMessage(error))
      }
    }
    return () => {
      if (typeof dispose === "function") dispose()
      root.replaceChildren()
    }
  }, [panel, api, apiConfig, runtime])
  return (
    <Section title={panel.title} description={panel.description}>
      {inactive && (
        <Alert status="accent" data-testid="admin-panel-inactive">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>This panel works on the emulator's own admin page</Alert.Title>
            <Alert.Description>
              {`${panel.title} is driven by a script the emulator supplies, and this page does not run scripts supplied as text. Open the emulator's own admin page (${apiConfig.service} at /__admin/ui) to use its controls. Every built-in screen works here.`}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <ErrorNotice error={error} />
      <div ref={host} className="min-w-0 overflow-x-auto" />
    </Section>
  )
}

const CORE_SCREENS = [
  { key: "overview", icon: <LayoutCellsLarge />, label: "Overview" },
  {
    key: "manual",
    icon: <Hand />,
    label: "Manual controls",
    keywords: "delay timeout loading retry error manual",
  },
  { key: "state", icon: <Database />, label: "State" },
  { key: "clock", icon: <Clock />, label: "Clock" },
  { key: "latency", icon: <Speedometer />, label: "Latency" },
  { key: "faults", icon: <ThunderboltFill />, label: "Faults" },
  {
    key: "snapshots",
    icon: <Camera />,
    label: "Snapshot & restore",
    keywords: "snapshot snapshots restore rollback save import export backup",
  },
  { key: "journal", icon: <ClockArrowRotateLeft />, label: "Journal" },
  {
    key: "checkpoints",
    icon: <BranchesRight />,
    label: "Checkpoints",
    keywords: "checkpoint branch checkout history timeline rewind",
  },
  { key: "routes", icon: <AbbrApi />, label: "Routes" },
] as const

function Workspace({ host, config }: { host: HTMLElement; config: AdminConfig }) {
  const runtime = useRuntime()
  const params = useMemo(() => new URL(runtime.href()).searchParams, [runtime])
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
  const [view, setView] = useState(new URL(runtime.href()).hash.slice(1) || "overview")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [narrow, setNarrow] = useState(host.clientWidth > 0 && host.clientWidth < 760)
  const api = useMemo(
    () => createApi(apiConfig, runtime.fetch, namespace, key),
    [apiConfig, namespace, key, runtime],
  )
  const manifest = useResource<Manifest>(api, "/ui/manifest", 0, false)
  const namespaces = useResource<{ namespaces: string[] }>(api, "/namespaces", revision)
  useEffect(() => {
    const root = host.getRootNode()
    // The box the shell fills: an embedder's frame, a shadow host, or else the host itself.
    const frame = runtime.viewport ?? (root instanceof ShadowRoot ? root.host : undefined)
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0) return
      setNarrow(entry.contentRect.width < 760)
    })
    observer.observe(frame ?? host)
    return () => observer.disconnect()
  }, [host, runtime])
  useEffect(() => {
    remember("mockingbird-admin-key", key)
    if (params.has("admin_key")) {
      const url = new URL(runtime.href())
      url.searchParams.delete("admin_key")
      runtime.replaceUrl(url.href)
    }
  }, [key, params, runtime])
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
    const target = runtime.shortcutTarget()
    target.addEventListener("keydown", open as EventListener)
    return () => target.removeEventListener("keydown", open as EventListener)
  }, [runtime])
  const panelList = [...(manifest.data?.panels ?? []), ...(manifest.data?.extensions ?? [])]
  const standardRoutes = manifest.data?.standardRoutes ?? apiConfig.standardRoutes
  const hasSql = panelList.some((panel) => panel.kind === "sql")
  const nav: { key: string; icon: ReactNode; label: string }[] = [
    ...CORE_SCREENS.map(({ key, icon, label }) => ({ key, icon, label })),
    ...panelList.map((panel) => ({
      key: panel.id,
      icon: panel.kind === "sql" ? <LayoutHeaderCells /> : <Puzzle />,
      label: panel.title,
    })),
  ]
  const goTo = (nextApi: string, nextView: string) => {
    setApiId(nextApi)
    setView(nextView)
    const url = new URL(runtime.href())
    url.hash = nextView
    runtime.replaceUrl(url.href)
  }
  const apiName = (candidate: AdminApiConfig) => candidate.label ?? candidate.service
  const paletteCommands: PaletteCommand[] = [
    ...apiConfigs.flatMap((candidate) =>
      CORE_SCREENS.map((screen) => ({
        id: `${candidate.id}:${screen.key}`,
        label: `${apiName(candidate)} · ${screen.label}`,
        detail:
          screen.key === "overview"
            ? `Switch to ${apiName(candidate)}`
            : screen.key === "snapshots"
              ? `Restore a snapshot of ${apiName(candidate)}: records, clock, faults and latency`
              : screen.key === "checkpoints"
                ? `Restore a checkpoint of ${apiName(candidate)}. History, not a snapshot`
                : `Open ${screen.label.toLocaleLowerCase()} for ${apiName(candidate)}`,
        keywords: `emulator service admin ${candidate.id} ${candidate.service} ${screen.key} ${"keywords" in screen ? screen.keywords : ""}`,
        icon: screen.icon,
        run: () => goTo(candidate.id, screen.key),
      })),
    ),
    ...panelList.map((panel) => ({
      id: `${apiConfig.id}:${panel.id}`,
      label: `${apiName(apiConfig)} · ${panel.title}`,
      detail: panel.description ?? `Open ${panel.title} for the current emulator`,
      keywords: `extension panel ${apiConfig.id} ${panel.id} ${panel.kind ?? "panel"}`,
      icon: panel.kind === "sql" ? <LayoutHeaderCells /> : <Puzzle />,
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
          panel && <CustomPanel panel={panel} api={api} apiConfig={apiConfig} />
        )
    }
  }
  return (
    <AppShell
      product="Admin"
      fluid
      actions={
        <>
          <Button variant="secondary" size="sm" onPress={() => setPaletteOpen(true)}>
            Jump
            <Kbd className="hidden sm:inline-flex">
              <Kbd.Abbr keyValue="command" />
              <Kbd.Content>K</Kbd.Content>
            </Kbd>
          </Button>
          <ThemeSwitch />
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div
          className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-separator pb-4"
          data-admin-context
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {apiConfigs.length > 1 ? (
                <SearchSelect
                  ariaLabel="Emulator"
                  value={apiConfig.id}
                  onChange={(next) => goTo(next, "overview")}
                  choices={apiConfigs.map((candidate) => ({
                    value: candidate.id,
                    label: apiName(candidate),
                  }))}
                  className="w-56"
                />
              ) : (
                <span className="text-lg font-semibold capitalize text-foreground">
                  {apiName(apiConfig)}
                </span>
              )}
              <StatusChip status="ok" dot>
                Live
              </StatusChip>
            </div>
            <Vendor config={config} service={apiConfig.service} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <SearchSelect
              ariaLabel="Namespace"
              value={namespace}
              onChange={setNamespace}
              choices={[...new Set([namespace, ...(namespaces.data?.namespaces ?? [])])].map(
                (name) => ({ value: name, label: name }),
              )}
              className="w-44"
            />
            <Form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                setKey(draftKey.trim())
                setRevision((n) => n + 1)
              }}
            >
              <TextInput
                ariaLabel="Admin key"
                type="password"
                placeholder="Admin key"
                value={draftKey}
                onChange={setDraftKey}
                className="w-40"
              />
              <Button type="submit" variant="secondary">
                Connect
              </Button>
            </Form>
            <Button variant="secondary" onPress={() => setRevision((n) => n + 1)}>
              <ArrowRotateRight className="size-4" />
              Refresh
            </Button>
          </div>
        </div>
        <div
          className={narrow ? "flex flex-col gap-6" : "grid grid-cols-[13rem_minmax(0,1fr)] gap-8"}
        >
          {narrow ? (
            <Choose
              ariaLabel="Screen"
              value={selected}
              onChange={(next) => goTo(apiConfig.id, next)}
              choices={nav.map((item) => ({ value: item.key, label: item.label }))}
            />
          ) : (
            <nav aria-label="Admin screens" className="sticky top-20 self-start">
              <ListBox
                aria-label="Screens"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[selected]}
                onSelectionChange={(keys) => {
                  const [next] = keys === "all" ? [] : [...keys]
                  if (next !== undefined) goTo(apiConfig.id, String(next))
                }}
                className="p-0"
              >
                {nav.map((item) => (
                  <ListBox.Item
                    key={item.key}
                    id={item.key}
                    textValue={item.label}
                    className="data-[selected=true]:bg-default data-[selected=true]:text-foreground"
                  >
                    <span className="text-muted [&_svg]:size-4">{item.icon}</span>
                    <span className="truncate">{item.label}</span>
                  </ListBox.Item>
                ))}
              </ListBox>
            </nav>
          )}
          <div className="flex min-w-0 flex-col gap-6">
            <ErrorNotice
              error={manifest.error ?? namespaces.error}
              retry={() => {
                manifest.reload()
                namespaces.reload()
              }}
            />
            {manifest.loading ? (
              <LoadingState label="Loading administration…" />
            ) : (
              <div key={`${apiId}:${namespace}:${key}:${selected}`} className="min-w-0">
                {content}
              </div>
            )}
          </div>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />
    </AppShell>
  )
}

/**
 * The precompiled design system stylesheet goes where the admin's markup is: the shadow root it
 * is mounted in, or the document's `<head>`. Each container gets it once, however many admins
 * are mounted there, and loses it when the last one is disposed.
 */
const STYLE_ATTRIBUTE = "data-mockingbird-admin-styles"
const styleUsers = new WeakMap<Element, number>()

function injectStyles(container: Element | ShadowRoot): () => void {
  let style = container.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`)
  if (!style) {
    style = document.createElement("style")
    style.setAttribute(STYLE_ATTRIBUTE, "")
    style.textContent = MOCKINGBIRD_CSS
    container.prepend(style)
  }
  const element = style
  styleUsers.set(element, (styleUsers.get(element) ?? 0) + 1)
  return () => {
    const users = (styleUsers.get(element) ?? 1) - 1
    styleUsers.set(element, users)
    if (users <= 0) element.remove()
  }
}

/** The theme root of one mount: the design system's provider, pinned light or dark. */
function Themed({ pinned, children }: { pinned?: Theme; children: ReactNode }) {
  const theme = useResolvedTheme(pinned)
  return (
    <MockingbirdProvider theme={theme} className="min-h-full">
      <Chrome>
        <Boundary>{children}</Boundary>
      </Chrome>
    </MockingbirdProvider>
  )
}

/**
 * Mount the admin shell into `host` and return its dispose function. The prebuilt document
 * calls this as `MockingbirdAdmin.mount(host, config)`; a page that bundles
 * `@crvouga/mockingbird-admin-ui/browser` calls it directly and can pass an `env` to answer
 * requests in-process and keep the shell off the page's own URL.
 */
export function mount(
  host: HTMLElement | null,
  config: AdminConfig,
  env?: AdminEnvironment,
): () => void {
  return mountRoot(host, env, () => (
    <Themed>
      <Workspace host={host as HTMLElement} config={config} />
    </Themed>
  ))
}

export function mountMembers(
  host: HTMLElement | null,
  config: MembersConfig,
  env?: AdminEnvironment,
): () => void {
  return mountRoot(host, env, () => (
    <Themed pinned={config.dark ? "dark" : "light"}>
      <Members config={config} />
    </Themed>
  ))
}

function mountRoot(
  host: HTMLElement | null,
  env: AdminEnvironment | undefined,
  render: () => ReactNode,
): () => void {
  if (!host) throw new Error("Admin root is missing")
  const styleRoot = host.getRootNode()
  const container =
    env?.styleContainer === false
      ? undefined
      : (env?.styleContainer ?? (styleRoot instanceof ShadowRoot ? styleRoot : document.head))
  const removeStyles = container ? injectStyles(container) : () => {}
  const mountPoint = document.createElement("div")
  host.append(mountPoint)
  const root = createRoot(mountPoint)
  root.render(
    <Boundary>
      <RuntimeProvider value={resolveEnvironment(env)}>{render()}</RuntimeProvider>
    </Boundary>,
  )
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener("mockingbird:unmount", dispose)
    window.removeEventListener("pagehide", dispose)
    root.unmount()
    mountPoint.remove()
    removeStyles()
  }
  document.addEventListener("mockingbird:unmount", dispose, { once: true })
  window.addEventListener("pagehide", dispose, { once: true })
  return dispose
}

export type { AdminEnvironment, PanelScript } from "./environment.js"
export type {
  AdminApiConfig,
  AdminConfig,
  AdminFetch,
  Api,
  MembersConfig,
  Panel,
} from "./model.js"
