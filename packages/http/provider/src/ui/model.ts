/**
 * The pages the provider emulators serve (sign-in, account pickers, errors, form posts,
 * inspectors, the Resend inbox, GitHub's authorized apps), described as plain data. Routes build
 * a `ProviderPage` with no React in sight; `src/ui/server.tsx` (loaded lazily, see
 * `vendor/core/ui.ts`) draws it with the Mockingbird design system as static HTML whose forms
 * post natively.
 */

/** What a status means; drawn by `StatusChip`. */
export type Status = "ok" | "warning" | "error" | "info" | "neutral"

/** One run of inline content. */
export type Inline =
  | string
  | { strong: string }
  | { code: string }
  | { link: string; href: string }
  | { chip: string; status?: Status }

/** Inline content: one run or several, in order. */
export type Rich = Inline | Inline[]

/** One seeded user to sign in as: a form that posts `hiddenFields` to `formAction`. */
export type AccountOption = {
  letter: string
  login: string
  name?: string
  email?: string
  formAction: string
  hiddenFields: Record<string, string>
}

/** A row of a link list: an email in the inbox, an authorized app. */
export type LinkItem = {
  href: string
  title: string
  description?: string
  letter: string
  status?: { label: string; status: Status }
}

export type Block =
  /** Seeded users to sign in as; `empty` when there are none. */
  | { type: "accounts"; accounts: AccountOption[]; empty: string }
  /** A titled group of blocks. */
  | {
      type: "section"
      title: string
      count?: number
      description?: Rich
      action?: FormBlock
      blocks: Block[]
    }
  /** A table; `empty` replaces it when there are no rows. */
  | { type: "table"; label: string; columns: string[]; rows: Rich[][]; empty: string }
  | { type: "json"; label: string; value: unknown }
  | { type: "code"; label?: string; code: string }
  | { type: "text"; text: Rich }
  | { type: "empty"; title: string; description?: string }
  /** Label and value pairs. */
  | { type: "details"; items: { label: string; value: Rich; mono?: boolean }[] }
  | { type: "links"; items: LinkItem[]; empty: string }
  /** A checklist: granted permissions. */
  | { type: "checklist"; items: string[]; empty: string }
  | { type: "chips"; chips: { label: string; status: Status }[] }
  /** Untrusted HTML (an email body) in a sandboxed frame. */
  | { type: "frame"; title: string; html: string }
  | FormBlock

/** A button that posts a form, natively (no JavaScript needed). */
export type FormBlock = {
  type: "form"
  action: string
  label: string
  variant?: "primary" | "secondary" | "danger"
  fields?: Record<string, string>
}

export type NavItem = { label: string; href: string; current?: boolean }

export type ProviderPage =
  /** A single-purpose page: sign-in, an error, a redirect. */
  | {
      layout: "card"
      /** The emulated product ("GitHub"). */
      service?: string
      /** The document title and the card's heading. */
      title: string
      description?: Rich
      blocks: Block[]
      /** An error page: the blocks are replaced by the message as an error. */
      error?: string
      /** Submit the page's first form on load (`response_mode=form_post`). */
      autoSubmit?: boolean
    }
  /** A tool page: the inspectors, the inbox, settings. */
  | {
      layout: "app"
      service?: string
      /** The document title. */
      title: string
      /** The page heading; defaults to `title`. */
      heading?: string
      description?: Rich
      /** Top-level sections, in the top bar. */
      nav: NavItem[]
      /** Where the brand links. */
      home?: string
      blocks: Block[]
    }
