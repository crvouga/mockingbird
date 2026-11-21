/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
/**
 * The pages the provider emulators serve. A route describes its page as data (`ProviderPage`,
 * src/ui/model.ts) and these helpers render it with the Mockingbird design system (React and
 * HeroUI, src/ui/page.tsx). The renderer is imported lazily, so React loads only when a page is
 * served, never on an API request.
 */
import type { AccountOption, Block, Inline, NavItem, ProviderPage, Rich, Status } from "../../ui/model.js";

export type {
  AccountOption,
  Block,
  FormBlock,
  Inline,
  LinkItem,
  NavItem,
  ProviderPage,
  Rich,
  Status,
} from "../../ui/model.js";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

/**
 * `page` as a complete HTML document: static, server-rendered HTML whose forms post natively.
 * The visitor's light or dark choice from other Mockingbird pages still applies.
 */
export async function renderProviderPage(page: ProviderPage): Promise<string> {
  const { renderProviderPage: render } = await import("#ui/server");
  return render(page);
}

/** A single-purpose page: a title, an optional description and content, under the brand. */
export function renderCardPage(title: string, description: Rich | undefined, blocks: Block[], service?: string) {
  return renderProviderPage({
    layout: "card",
    title,
    blocks,
    ...(description === undefined ? {} : { description }),
    ...(service ? { service } : {}),
  });
}

/** An account picker: one button per seeded user. */
export function renderSignInPage(
  title: string,
  description: Rich,
  accounts: AccountOption[],
  service?: string,
  empty = "No users in the emulator store.",
) {
  return renderCardPage(title, description, [{ type: "accounts", accounts, empty }], service);
}

export function renderErrorPage(title: string, message: string, service?: string) {
  return renderProviderPage({ layout: "card", title, error: message, blocks: [], ...(service ? { service } : {}) });
}

export interface InspectorTab {
  id: string;
  label: string;
  href: string;
}

/** A tool page: the tabs in the top bar, the active one's content below. */
export function renderInspectorPage(
  title: string,
  tabs: InspectorTab[],
  activeTab: string,
  blocks: Block[],
  service?: string,
) {
  const nav: NavItem[] = tabs.map((tab) => ({
    label: tab.label,
    href: tab.href,
    ...(tab.id === activeTab ? { current: true } : {}),
  }));
  const active = tabs.find((tab) => tab.id === activeTab);
  return renderProviderPage({
    layout: "app",
    title: active ? `${active.label} · ${title}` : title,
    heading: active?.label ?? title,
    description: title,
    nav,
    blocks,
    ...(service ? { service } : {}),
  });
}

/** The page that posts a response back to the app (`response_mode=form_post`): it submits itself. */
export function renderFormPostPage(action: string, fields: Record<string, string>, service?: string) {
  return renderProviderPage(formPostPage(action, fields, service));
}

/** The form post page as data. */
export function formPostPage(
  action: string,
  fields: Record<string, string>,
  service?: string,
): Extract<ProviderPage, { layout: "card" }> {
  return {
    layout: "card",
    title: "Redirecting…",
    description: "Returning you to the app.",
    autoSubmit: true,
    blocks: [
      {
        type: "form",
        action,
        label: "Continue",
        fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null)),
      },
    ],
    ...(service ? { service } : {}),
  };
}

/** A table block, or its `empty` message when there are no rows. Inside `section`, it is labelled by the section's title. */
export function table(columns: string[], rows: Rich[][], empty: string, label = ""): Block {
  return { type: "table", label, columns, rows, empty };
}

/** A titled section of blocks. */
export function section(title: string, ...blocks: Block[]): Block {
  return {
    type: "section",
    title,
    blocks: blocks.map((block) => (block.type === "table" && !block.label ? { ...block, label: title } : block)),
  };
}

const OK = /^(ok|active|enabled|open|delivered|sent|received|read|approved|completed?|success(ful)?|available|granted|verified|2\d\d)$/i;
const ERROR = /^(failed|error|revoked|inactive|disabled|closed|canceled|cancelled|bounced|denied|undelivered|archived|deleted|expired|used|busy|no-answer|[45]\d\d)$/i;
const WARNING = /^(pending|queued|sending|accepted|scheduled|in-progress|ringing|initiated|requested|processing|delayed)$/i;

/** A status as a chip, its color read from the word ("active", "failed", "queued", "200"). */
export function chip(label: string, status: Status = statusOf(label)): Inline {
  return { chip: label, status };
}

function statusOf(label: string): Status {
  if (OK.test(label)) return "ok";
  if (ERROR.test(label)) return "error";
  if (WARNING.test(label)) return "warning";
  return "neutral";
}
