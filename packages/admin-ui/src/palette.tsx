import { CheckOutlined, SearchOutlined } from "@ant-design/icons"
import type { InputRef } from "antd"
import { Flex, Input, Modal, Result, Typography } from "antd"
import type { ReactNode, Ref } from "react"
import { useEffect, useId, useRef, useState } from "react"

export type PaletteCommand = {
  id: string
  label: string
  detail: string
  keywords: string
  icon: ReactNode
  run(): void
}

type Colors = { surface: string; border: string; selected: string }

const paletteColors = (dark: boolean): Colors =>
  dark
    ? { surface: "#171d26", border: "#343e4c", selected: "rgba(91,156,246,.16)" }
    : { surface: "#ffffff", border: "#d4dae3", selected: "#eaf2ff" }

export const matchCommands = (
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] => {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.detail} ${command.keywords}`.toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * The search box and its results. Focus stays in the box while the arrow keys move the
 * highlight, so the box is a combobox that names the highlighted option and keeps it in view.
 */
export function PaletteSearch({
  commands,
  query,
  active,
  onQuery,
  onActive,
  onChoose,
  colors,
  inputRef,
}: {
  commands: readonly PaletteCommand[]
  query: string
  active: number
  onQuery(query: string): void
  onActive(update: (index: number) => number): void
  onChoose(command: PaletteCommand | undefined): void
  colors: Colors
  inputRef?: Ref<InputRef>
}) {
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const list = useRef<HTMLDivElement>(null)
  const visible = matchCommands(commands, query)
  const current = visible.length === 0 ? -1 : Math.min(active, visible.length - 1)
  const selected = visible[current]
  // The list scrolls on its own; without this a highlight moved by the keyboard leaves the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlighted id is what moved.
  useEffect(() => {
    if (current < 0) return
    list.current
      ?.querySelector<HTMLElement>(`[id="${CSS.escape(optionId(current))}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [current, listId])
  return (
    <>
      <Input
        ref={inputRef}
        variant="borderless"
        size="large"
        prefix={<SearchOutlined />}
        suffix={<Typography.Text keyboard>esc</Typography.Text>}
        role="combobox"
        aria-label="Admin command palette"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        {...(current < 0 ? {} : { "aria-activedescendant": optionId(current) })}
        placeholder="Jump to an emulator or screen…"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          // Escape still has to reach the dialog's own handler, which closes the palette.
          if (event.key !== "Escape") event.stopPropagation()
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            const delta = event.key === "ArrowDown" ? 1 : -1
            onActive((index) =>
              visible.length === 0 ? 0 : (index + delta + visible.length) % visible.length,
            )
          } else if (event.key === "Enter") {
            event.preventDefault()
            onChoose(selected)
          }
        }}
        style={{ padding: "16px 18px", fontSize: 16 }}
      />
      <div style={{ borderTop: `1px solid ${colors.border}` }}>
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Commands"
          style={{ maxHeight: 440, overflowY: "auto", padding: 8 }}
        >
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
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === current}
                onMouseEnter={() => onActive(() => index)}
                onClick={() => onChoose(command)}
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
                  background: index === current ? colors.selected : "transparent",
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
                {index === current && (
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
    </>
  )
}

export function CommandPalette({
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
  const input = useRef<InputRef>(null)
  const colors = paletteColors(dark)
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
      <PaletteSearch
        commands={commands}
        query={query}
        active={active}
        onQuery={(next) => {
          setQuery(next)
          setActive(0)
        }}
        onActive={setActive}
        onChoose={choose}
        colors={colors}
        inputRef={input}
      />
    </Modal>
  )
}
