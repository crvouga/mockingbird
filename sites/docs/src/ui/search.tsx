import { StarFill } from "@gravity-ui/icons"
import {
  AutocompleteFilter,
  Button,
  Description,
  Header,
  Kbd,
  Label,
  ListBox,
  Modal,
  SearchField,
} from "@heroui/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { KEYS, store } from "../client/storage.ts"
import { score, terms } from "../lib/search.ts"
import type { PaletteEntry } from "../pages/search.json.ts"
import { Icon } from "./icon.tsx"
import { Monogram } from "./primitives.tsx"

type Group = { label: string; items: PaletteEntry[] }

let index: Promise<PaletteEntry[]> | undefined
const load = (): Promise<PaletteEntry[]> => {
  index ??= fetch("/search.json")
    .then((response) => response.json() as Promise<PaletteEntry[]>)
    .catch((error: unknown) => {
      index = undefined
      throw error
    })
  return index
}

/** With no query: recently viewed, featured, pages, then a few emulators. */
function browse(entries: PaletteEntry[]): Group[] {
  const recentNames = store.getJson<string[]>(KEYS.recent, [])
  const recent = recentNames
    .map((name) => entries.find((e) => e.kind === "service" && e.name === name))
    .filter((e): e is PaletteEntry => Boolean(e))
  return [
    { label: "Recently viewed", items: recent },
    {
      label: "Featured emulators",
      items: entries.filter(
        (e) => e.kind === "service" && e.featured && !recentNames.includes(e.name),
      ),
    },
    { label: "Pages", items: entries.filter((e) => e.kind === "page") },
    {
      label: "Emulators",
      items: entries
        .filter((e) => e.kind === "service" && !e.featured && !recentNames.includes(e.name))
        .slice(0, 8),
    },
  ]
}

/** Ranked matches, pages first when a page's title is the better match. */
function search(entries: PaletteEntry[], query: string): Group[] {
  const q = terms(query)
  const ranked = entries
    .map((entry) => ({ entry, rank: score(q, entry) }))
    .filter((r): r is { entry: PaletteEntry; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.entry.displayName.localeCompare(b.entry.displayName))
    .map((r) => r.entry)
  const pages = ranked.filter((e) => e.kind === "page")
  const services = ranked.filter((e) => e.kind === "service").slice(0, 12)
  const pageRank = pages[0] ? score(q, pages[0]) : null
  const serviceRank = services[0] ? score(q, services[0]) : null
  const pageGroup = { label: "Pages", items: pages }
  const serviceGroup = { label: "Emulators", items: services }
  return pageRank !== null && (serviceRank === null || pageRank <= serviceRank)
    ? [pageGroup, serviceGroup]
    : [serviceGroup, pageGroup]
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/**
 * The site search: a button in the top bar and a HeroUI Modal with a SearchField over a ListBox
 * of emulators and guide pages (`/search.json`, fetched on first use). Opens with ⌘K / Ctrl K,
 * with "/" on pages without a search of their own, and from any `[data-palette-open]` button.
 */
export function SiteSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [entries, setEntries] = useState<PaletteEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [mod, setMod] = useState("⌘K")

  const show = useCallback(() => {
    setQuery("")
    setOpen(true)
    load().then(setEntries, () => setFailed(true))
  }, [])

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setMod("Ctrl+K")
    const onKey = (event: KeyboardEvent) => {
      // A live example owns the keyboard while its window is open.
      if (event.defaultPrevented || document.querySelector("dialog[data-example-modal][open]"))
        return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        show()
      } else if (
        event.key === "/" &&
        !typing(event.target) &&
        !document.querySelector("[data-local-search]")
      ) {
        event.preventDefault()
        show()
      }
    }
    const onClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.("[data-palette-open]")) show()
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("click", onClick)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("click", onClick)
    }
  }, [show])

  const groups = useMemo(
    () =>
      entries
        ? (query.trim() ? search(entries, query) : browse(entries)).filter(
            (g) => g.items.length > 0,
          )
        : [],
    [entries, query],
  )

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="hidden w-60 justify-start text-muted lg:inline-flex"
        onPress={show}
        onHoverStart={() => void load().catch(() => {})}
        aria-label="Search documentation"
        data-palette-trigger
      >
        <Icon name="search" />
        <span className="flex-1 text-left">Search documentation…</span>
        <Kbd>{mod}</Kbd>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        className="lg:hidden"
        onPress={show}
        aria-label="Search documentation"
      >
        <Icon name="search" />
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container placement="top" size="lg" scroll="inside">
          <Modal.Dialog aria-label="Search" className="max-h-[min(36rem,calc(100dvh-6rem))] p-0">
            <AutocompleteFilter inputValue={query} onInputChange={setQuery}>
              <div className="border-b border-separator p-3">
                <SearchField aria-label="Search documentation" fullWidth autoFocus>
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="Search documentation, operations, pages…" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {failed ? (
                  <p className="px-3 py-8 text-center text-sm text-muted">
                    The search index could not load. Try again in a moment.
                  </p>
                ) : !entries ? (
                  <p className="px-3 py-8 text-center text-sm text-muted">Loading…</p>
                ) : (
                  <ListBox
                    aria-label="Results"
                    renderEmptyState={() => (
                      <p className="px-3 py-8 text-center text-sm text-muted">
                        No results for “{query}”
                      </p>
                    )}
                    onAction={() => setOpen(false)}
                  >
                    {groups.map((group) => (
                      <ListBox.Section key={group.label}>
                        <Header className="px-2 pt-3 pb-1 text-xs font-semibold text-muted">
                          {group.label}
                        </Header>
                        {group.items.map((entry) => (
                          <ListBox.Item
                            key={`${group.label}:${entry.href}`}
                            id={`${group.label}:${entry.href}`}
                            href={entry.href}
                            textValue={entry.displayName}
                            className="gap-3"
                          >
                            {entry.kind === "service" ? (
                              <Monogram name={entry.displayName} logo={entry.logo} size="sm" />
                            ) : (
                              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-default text-muted">
                                <Icon name="file" />
                              </span>
                            )}
                            <div className="flex min-w-0 flex-1 flex-col">
                              <Label className="flex items-center gap-1.5">
                                {entry.featured ? (
                                  <StarFill
                                    className="size-3 text-accent"
                                    aria-label="Featured emulator"
                                  />
                                ) : null}
                                {entry.displayName}
                              </Label>
                              <Description className="truncate">{entry.subtitle}</Description>
                            </div>
                            <span
                              className="hidden max-w-40 shrink-0 truncate text-xs text-muted sm:block"
                              title={entry.kind === "service" ? entry.parity : undefined}
                            >
                              {entry.kind === "service" ? entry.parity : "Page"}
                            </span>
                          </ListBox.Item>
                        ))}
                      </ListBox.Section>
                    ))}
                  </ListBox>
                )}
              </div>
            </AutocompleteFilter>
            <div className="hidden gap-4 border-t border-separator bg-surface-secondary px-4 py-2 text-xs text-muted sm:flex">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> to navigate
              </span>
              <span>
                <Kbd>↵</Kbd> to open
              </span>
              <span className="ml-auto">
                <Kbd>esc</Kbd> to close
              </span>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
