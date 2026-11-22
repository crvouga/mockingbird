import type { ReactNode } from "react"

export type KeyValueItem = {
  label: ReactNode
  value: ReactNode
  /** Draw the value in monospace: ids, keys, URLs, timestamps. */
  mono?: boolean
  /** React key. Default: the label when it is a string. */
  id?: string
}

export type KeyValueListProps = {
  items: KeyValueItem[]
  className?: string
}

/**
 * Labelled values (a resource's fields, a request's metadata): two columns, stacking on a phone.
 * Renders a `<dl>`, so each label is announced with its value.
 */
export function KeyValueList({ items, className }: KeyValueListProps) {
  return (
    <dl
      className={`grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[minmax(8rem,max-content)_1fr] ${className ?? ""}`.trim()}
      data-mockingbird-key-values
    >
      {items.map((item, index) => (
        <div
          key={item.id ?? (typeof item.label === "string" ? item.label : index)}
          className="grid grid-cols-subgrid border-b border-separator py-2 last:border-b-0 sm:col-span-2"
        >
          <dt className="text-muted">{item.label}</dt>
          <dd
            className={`m-0 min-w-0 break-words text-foreground ${item.mono ? "font-mono text-[13px]" : ""}`}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
