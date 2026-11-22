import { EmptyState } from "@crvouga/mockingbird-ui/react"
import { Autocomplete, Kbd, ListBox, Modal, SearchField } from "@heroui/react"
import type { ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { usePortal } from "./components.js"

export type PaletteCommand = {
  id: string
  label: string
  detail: string
  keywords: string
  icon: ReactNode
  run(): void
}

const haystack = (command: PaletteCommand): string =>
  `${command.label} ${command.detail} ${command.keywords}`.toLocaleLowerCase()

/** Whether every word of `query` appears in the command's label, detail or keywords. */
export const commandMatches = (command: PaletteCommand, query: string): boolean => {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const text = haystack(command)
  return words.every((word) => text.includes(word))
}

export const matchCommands = (
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] => commands.filter((command) => commandMatches(command, query))

/**
 * The search box and its results: a HeroUI SearchField and ListBox inside React Aria's
 * Autocomplete. Focus stays in the box while the arrow keys move a virtual highlight through the
 * list (the box names it with `aria-activedescendant`); Enter runs the highlighted command, or
 * the first match when nothing is highlighted yet.
 */
export function PaletteSearch({
  commands,
  query,
  onQuery,
  onChoose,
  autoFocus = false,
}: {
  commands: readonly PaletteCommand[]
  query: string
  onQuery(query: string): void
  onChoose(command: PaletteCommand | undefined): void
  autoFocus?: boolean
}) {
  const byId = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands])
  const input = useRef<HTMLInputElement>(null)
  return (
    <Autocomplete.Filter
      inputValue={query}
      onInputChange={onQuery}
      filter={(_text, value, node) => {
        const command = byId.get(String(node.key))
        return command ? commandMatches(command, value) : false
      }}
    >
      <SearchField
        aria-label="Admin command palette"
        autoFocus={autoFocus}
        className="w-full"
        onSubmit={() => {
          // With a highlighted option, the list runs it; otherwise Enter takes the first match.
          if (input.current?.getAttribute("aria-activedescendant")) return
          onChoose(matchCommands(commands, query)[0])
        }}
      >
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input ref={input} placeholder="Jump to an emulator or screen…" />
          <Kbd className="me-2 hidden sm:inline-flex">esc</Kbd>
        </SearchField.Group>
      </SearchField>
      <ListBox
        aria-label="Commands"
        className="mt-2 max-h-[min(440px,60dvh)] overflow-y-auto"
        onAction={(key) => onChoose(byId.get(String(key)))}
        renderEmptyState={() => (
          <EmptyState title="No commands found" description="Try an emulator or screen name." />
        )}
      >
        {commands.map((command) => (
          <ListBox.Item key={command.id} id={command.id} textValue={command.label}>
            <span className="text-accent [&_svg]:size-4">{command.icon}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-foreground">{command.label}</span>
              <span className="truncate text-xs text-muted">{command.detail}</span>
            </span>
          </ListBox.Item>
        ))}
      </ListBox>
    </Autocomplete.Filter>
  )
}

/** Command/Ctrl + K: jump to any emulator and screen the shell presents. */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean
  onClose(): void
  commands: readonly PaletteCommand[]
}) {
  const portal = usePortal()
  const [query, setQuery] = useState("")
  useEffect(() => {
    if (open) setQuery("")
  }, [open])
  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return
    command.run()
    onClose()
  }
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      {...portal}
    >
      <Modal.Container size="lg" placement="top">
        <Modal.Dialog aria-label="Command palette">
          <Modal.Body className="p-1">
            <PaletteSearch
              commands={commands}
              query={query}
              onQuery={setQuery}
              onChoose={choose}
              autoFocus
            />
          </Modal.Body>
          <Modal.Footer className="flex justify-between gap-3 text-xs text-muted">
            <span>↑↓ Navigate · ↵ Open</span>
            <span className="hidden sm:inline">Emulators and admin screens</span>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
