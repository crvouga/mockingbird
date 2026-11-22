import { EmptyState, Logo } from "@crvouga/mockingbird-ui/react"
import { LayoutCells, ListUl, StarFill } from "@gravity-ui/icons"
import {
  Button,
  Card,
  Kbd,
  ListBox,
  SearchField,
  Select,
  Tag,
  TagGroup,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { KEYS, store } from "../client/storage.ts"
import { score, terms } from "../lib/search.ts"
import { ServiceCard, type ServiceSummary } from "./service-card.tsx"

export type CatalogEntry = ServiceSummary & {
  /** Everything a query matches: names, vendor, keywords, operation ids. */
  text: string
}

export type CatalogCategory = { slug: string; label: string; count: number }

const SORTS = [
  { id: "relevance", label: "Best match" },
  { id: "name", label: "Name" },
  { id: "ops", label: "Most operations" },
  { id: "category", label: "Category" },
] as const
type Sort = (typeof SORTS)[number]["id"]
const isSort = (value: unknown): value is Sort => SORTS.some((s) => s.id === value)

/**
 * The emulator catalog: search, a category, featured only, a sort and grid or list. The URL owns
 * the shareable state (`?q=&category=&featured=1&sort=`), localStorage the view. Server-rendered
 * with every card, so the page reads without JavaScript; `[data-local-search]` keeps "/" here
 * instead of the site search.
 */
export function Catalog({
  services,
  categories,
}: {
  services: CatalogEntry[]
  categories: CatalogCategory[]
}) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("")
  const [featured, setFeatured] = useState(false)
  const [sort, setSort] = useState<Sort>("relevance")
  const [view, setView] = useState<"grid" | "list">("grid")
  const ready = useRef(false)
  const search = useRef<HTMLInputElement>(null)

  // Restore the shared state from the URL and the view from storage, once hydrated.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setQuery(params.get("q") ?? "")
    const slug = params.get("category") ?? ""
    setCategory(categories.some((c) => c.slug === slug) ? slug : "")
    setFeatured(params.get("featured") === "1")
    const sortParam = params.get("sort")
    if (isSort(sortParam)) setSort(sortParam)
    if (store.get(KEYS.servicesView) === "list") setView("list")
    ready.current = true
  }, [categories])

  useEffect(() => {
    if (!ready.current) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams()
      if (query.trim()) next.set("q", query.trim())
      if (category) next.set("category", category)
      if (featured) next.set("featured", "1")
      if (sort !== "relevance") next.set("sort", sort)
      const qs = next.toString()
      if (location.search !== (qs ? `?${qs}` : ""))
        history.replaceState(null, "", qs ? `?${qs}` : location.pathname)
    }, 150)
    return () => clearTimeout(timer)
  }, [query, category, featured, sort])

  const visible = useMemo(() => {
    const q = terms(query)
    return services
      .map((card) => ({ card, rank: score(q, card) }))
      .filter(
        (r): r is { card: CatalogEntry; rank: number } =>
          r.rank !== null &&
          (!category || r.card.category === category) &&
          (!featured || r.card.featured),
      )
      .sort((a, b) => {
        if (sort === "relevance" && a.rank !== b.rank) return a.rank - b.rank
        if (sort === "relevance" && a.card.featured !== b.card.featured)
          return Number(b.card.featured) - Number(a.card.featured)
        if (sort === "ops" && a.card.opsSupported !== b.card.opsSupported)
          return b.card.opsSupported - a.card.opsSupported
        if (sort === "category" && a.card.category !== b.card.category)
          return a.card.category.localeCompare(b.card.category)
        return a.card.displayName.localeCompare(b.card.displayName)
      })
      .map((r) => r.card)
  }, [services, query, category, featured, sort])

  // "/" focuses the search; Enter opens the first match.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const t = event.target as HTMLElement
      if (event.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
        event.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const clear = () => {
    setQuery("")
    setSort("relevance")
    setFeatured(false)
    setCategory("")
    search.current?.focus()
  }

  const total = services.length
  const featuredCount = services.filter((s) => s.featured).length
  return (
    <div data-local-search>
      <div className="z-10 -mx-4 sm:sticky sm:top-14 flex flex-col gap-3 bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <SearchField
          aria-label="Search emulators"
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            const first = visible[0]
            if (first) location.href = `/services/${first.name}`
          }}
          fullWidth
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input
              ref={search}
              placeholder={`Search ${total} emulators, keywords, operation ids…`}
              data-q
            />
            <SearchField.ClearButton />
            <Kbd className="mr-2 hidden sm:inline-flex">/</Kbd>
          </SearchField.Group>
        </SearchField>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TagGroup
            aria-label="Category"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[category || "all"]}
            onSelectionChange={(keys) => {
              const [key] = [...keys]
              setCategory(key === "all" || key === undefined ? "" : String(key))
            }}
            className="order-last w-full min-w-0"
          >
            <TagGroup.List className="flex-nowrap overflow-x-auto pb-1 sm:flex-wrap">
              <Tag id="all" className="shrink-0">
                All <span className="text-muted tabular-nums">{total}</span>
              </Tag>
              {categories.map((c) => (
                <Tag key={c.slug} id={c.slug} className="shrink-0" data-cat={c.slug}>
                  {c.label} <span className="text-muted tabular-nums">{c.count}</span>
                </Tag>
              ))}
            </TagGroup.List>
          </TagGroup>
          <p className="text-sm text-muted" aria-live="polite" data-count>
            {visible.length === total
              ? `${total} emulators`
              : `${visible.length} of ${total} emulators`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleButton
              size="sm"
              isSelected={featured}
              onChange={setFeatured}
              data-featured-filter
            >
              <StarFill className="size-3.5" />
              Featured <span className="text-muted tabular-nums">{featuredCount}</span>
            </ToggleButton>
            <Select
              aria-label="Sort"
              selectedKey={sort}
              onSelectionChange={(key) => {
                if (isSort(key)) setSort(key)
              }}
              className="w-40"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {SORTS.map((s) => (
                    <ListBox.Item key={s.id} id={s.id} textValue={s.label}>
                      {s.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <ToggleButtonGroup
              aria-label="View"
              size="sm"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[view]}
              onSelectionChange={(keys) => {
                const [next] = [...keys]
                if (next !== "grid" && next !== "list") return
                setView(next)
                store.set(KEYS.servicesView, next)
              }}
            >
              <ToggleButton id="grid" isIconOnly aria-label="Grid view">
                <LayoutCells className="size-4" />
              </ToggleButton>
              <ToggleButton id="list" isIconOnly aria-label="List view">
                <ListUl className="size-4" />
              </ToggleButton>
            </ToggleButtonGroup>
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <Card className="mt-2" data-empty>
          <EmptyState
            icon={<Logo size={40} />}
            title="No emulators match"
            description="Try a vendor name, a keyword or an operation id, or clear the filters."
            action={
              <Button size="sm" variant="secondary" onPress={clear} data-clear>
                Clear filters
              </Button>
            }
          />
        </Card>
      ) : view === "list" ? (
        <Card className="mt-2 gap-0 divide-y divide-separator p-0" data-grid data-view="list">
          {visible.map((s) => (
            <ServiceCard key={s.name} service={s} view="list" />
          ))}
        </Card>
      ) : (
        <div
          className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4"
          data-grid
          data-view="grid"
        >
          {visible.map((s) => (
            <ServiceCard key={s.name} service={s} />
          ))}
        </div>
      )}
    </div>
  )
}
