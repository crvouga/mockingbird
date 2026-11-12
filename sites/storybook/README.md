# Mockingbird UI catalog (Storybook)

Every piece of UI in this repo — each emulator's hosted pages (Checkout, sign-in, consent,
inboxes, inspectors), the Stripe.js stand-in's Elements, the admin UIs, the example apps, the
docs site's pages and the dev reports — is a story here. **Do UI work here**: open the story for
the screen you are changing, change the source, and watch it re-render (packages are read from
`src/`, not `dist/`, so there is no build step in the loop).

```sh
bun run --cwd sites/storybook dev        # http://localhost:6008, with Fleet Cloud (6006) and notifications (6007) composed in
bun run --cwd sites/storybook storybook  # only this catalog
bun run --cwd sites/storybook build      # storybook-static/, refs copied into fleet/ and notifications/
bun run --cwd sites/storybook verify     # every story must render and play without an error
bun run --cwd sites/storybook screenshots -- --only emulators-stripe   # PNGs in .tmp/screenshots
```

Published with the docs site at `/storybook/` (the docs build copies `storybook-static` in).
`bun run check:storybook` (part of `bun run check`) fails when a UI source file is in no story.

## Composition

The Fleet Cloud dashboard (`sites/fleet`) and the notifications harness (`packages/notifications`)
keep their own Storybooks, because each styles the whole page. This one composes them as refs,
so the published catalog shows all three in one sidebar.

## Writing a story

Stories live in `stories/<area>/<product>/<surface>.stories.ts`, titled
`<Area>/<Product>/<Surface>` (`Emulators/Stripe/Checkout`). Areas: `Emulators`, `Admin`,
`Examples`, `Docs site`, `Reports`. One story per state a person can see: empty, filled,
loading, every error, success, a phone-width variant for pages people use on phones.

Two factories in `src/story.ts`, both drawing into a frame (`src/frame.ts`) so the UI's styles and
scripts stay its own, as in a browser tab:

- **`page(setup)`** — a page an emulator serves. `setup` starts the real emulator in the browser
  (`createRuntime()` from the service package), puts it in the state the page shows **through
  its own API**, and returns `{ emulator, url }`. The frame then routes the page's form posts,
  links and `fetch` calls on that origin back to the emulator, so the page is usable: a story's
  `play` can submit a form and see the emulator's real answer. Prefer this over fixtures.
- **`markup(render)`** — a document or fragment from a pure function (an email layout, a report).

States reached by acting (typing, submitting, errors) are `play` functions using `src/interact.ts`
(`hands(canvasElement)`: `type`, `click`, `get`, `navigated`), finding controls by
`data-testid`, typing key by key so the page's own scripts run. Assert with `expect` from
`storybook/test`: `verify` fails on a failed assertion.

Name the source files a story draws in its meta: `parameters: { sources: ["packages/service/stripe/src/checkout-page.ts"] }`
(repo-relative). `check:storybook` counts a UI file as catalogued when a story imports it or lists
it there, and the list tells the next person which file to open.

Build a slice while working: `STORIES=../stories/emulators/stripe/**/*.stories.ts bun run storybook:build`.

Shared fixtures for a product sit next to its stories (`stories/emulators/stripe/stripe.ts`).
Import UI source by relative path (`../../../../../packages/service/stripe/src/stripe-js.js`) or
by package name (aliased to `src/index.ts`), and declare the package in this `package.json`'s
`devDependencies` (`bun run check:boundaries` insists).
