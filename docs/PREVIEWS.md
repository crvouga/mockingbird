# Live PR previews

Give every pull request a live, self-updating preview of your app on Cloudflare Workers, with one
workflow file and no setup beyond the Cloudflare credentials any hosting needs.

Each preview shows where CI is (a build for a newer commit running, deployed or failed; the PR's
checks running, passed or failed) and updates itself in place when a newer version deploys: an
open tab never needs a reload. The infrastructure is stateless: no database, no Durable Objects,
no GitHub token.

- [How it works](#how-it-works)
- [Use it in your project](#use-it-in-your-project)
- [Inputs](#inputs)
- [Named Previews of one assets-only Worker](#named-previews-of-one-assets-only-worker)
- [What a preview does not do](#what-a-preview-does-not-do)

## How it works

```mermaid
flowchart LR
  PR["Pull request<br/>opened / pushed / closed"] --> WF["Reusable workflow<br/>preview.yml"]
  CI["Your CI workflow<br/>(workflow_run)"] --> WF
  WF -- "build, stamp version.json,<br/>wrangler deploy" --> W["Preview Worker<br/>&lt;name&gt;-pr-&lt;n&gt;"]
  WF -- "wrangler secret bulk<br/>PREVIEW_BUILD / PREVIEW_CHECKS" --> W
  W -- "SSE /__preview/live<br/>(fallback: polling /__preview/status)" --> Tab["Open tab<br/>boot loader"]
  W -- "/version.json" --> Tab
  Tab -- "import app-&lt;hash&gt;.js in place" --> App["Your app"]
```

- **Status is pushed by CI into the Worker itself.** When a build starts, deploys or fails, and
  when your CI workflow starts or finishes for the PR, the workflow writes `PREVIEW_BUILD` or
  `PREVIEW_CHECKS` into the preview Worker's configuration with `wrangler secret bulk`, using the
  Cloudflare credentials it already has. Cloudflare rolls a new version of the same Worker with
  the new value; nothing else stores state.
- **The Worker is a stateless function.** `createPreviewWorker` from `@crvouga/mockingbird-preview`
  serves your static build and `/__preview/*`: the status from its own configuration plus the
  deployed version from `version.json`, as JSON and as short-lived Server-Sent Events that the
  browser reconnects to (so a new Worker version reaches open tabs within about 25 s). Without SSE
  the tab polls `/__preview/status` itself, faster while a build runs. Requests from other sites
  are refused.
- **Updates without reloading.** `index.html` loads a small boot loader that never changes.
  `version.json`, stamped with the PR head at deploy, names your app's hashed entry. When a newer
  one is live, the loader unmounts the running app and imports the new one into the same page,
  after a short countdown (**Update now** / **Not now**), or at once in a background tab. A lazy
  chunk that a deploy removed also triggers the update.
- **Freshness everywhere**, when your app uses `mountSystemHarness` from `@crvouga/mockingbird-ui`
  with the `build` the boot loader passes: a status dot on the switcher, an update toast, and a
  Preview card on the System screen (this tab's version and age, the latest deploy, build and
  checks with links, the connection).

## Use it in your project

1. **Export `start` from your app's entry.** It mounts the app and returns a disposer:

   ```ts
   // src/preview-app.ts
   export const start = async (host: HTMLElement, options: { build?: unknown }) => {
     const unmount = mountMyApp(host, options) // pass options.build to mountSystemHarness if you use it
     return () => unmount()
   }
   ```

2. **Build the preview** with the package's helper (a script your `build` input runs):

   ```ts
   // scripts/build-preview.ts
   import { buildPreview } from "@crvouga/mockingbird-preview/build"
   await buildPreview({ entry: "src/preview-app.ts", outdir: "preview-dist", title: "My app preview" })
   ```

3. **Add one workflow** and the two secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`:

   ```yaml
   # .github/workflows/preview.yml
   name: Preview
   on:
     pull_request: { types: [opened, synchronize, reopened, closed] }
     workflow_run: { workflows: [CI], types: [requested, completed] }   # your CI workflow's name
   permissions: { contents: read, pull-requests: write }
   jobs:
     preview:
       uses: crvouga-organization/mockingbird/.github/workflows/preview.yml@main
       with:
         name: my-app
         build: bun scripts/build-preview.ts
         outdir: preview-dist
       secrets:
         CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
         CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
   ```

That is all. The workflow generates the Worker's wrangler config (the package's Worker serving
`outdir`), deploys `my-app-pr-<n>`, puts a **Preview** link at the top of the PR, keeps the
preview's status live, and deletes the Worker when the PR closes. Forks get no secrets, so their
PRs are skipped. The lab in this repo uses exactly this
([system-preview.yml](../.github/workflows/system-preview.yml)), with its own Worker to add the
[dev resources](DEV_RESOURCES.md) proxy.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | `worker` | `worker`: a Worker per PR, as described above. `named-previews`: see [below](#named-previews-of-one-assets-only-worker). |
| `name` | (required in `worker` mode) | Worker name prefix; each PR deploys `<name>-pr-<number>`. |
| `build` | (required unless `sites` gives it) | Builds the preview into `outdir`. |
| `outdir` | (required unless `sites` gives it) | The built preview, relative to `working-directory`. |
| `working-directory` | `.` | Where install, build, the CLI and wrangler run. |
| `install` | `bun install --frozen-lockfile` | Installs dependencies, including `@crvouga/mockingbird-preview`. |
| `wrangler-config` | generated | Your own wrangler config, for a custom Worker built on `createPreviewWorker`. |
| `cli` | `bunx mockingbird-preview` | How to run the package's CLI (`stamp`, `wrangler-config`). |
| `bun-version` / `wrangler` | `1.4.0` / `bunx wrangler@4.50.0` | Tool versions. |

Secrets are passed explicitly, never with `secrets: inherit`, so the workflow sees only what you
hand it: the two Cloudflare values, and optionally `WORKER_SECRETS`, `KEY=value` lines to set on
the preview Worker (for example [dev resources](DEV_RESOURCES.md) credentials):

```yaml
       secrets:
         CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
         CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
         WORKER_SECRETS: |
           STRIPE_SECRET_KEY=${{ secrets.STRIPE_SECRET_KEY }}
```

## Named Previews of one assets-only Worker

`mode: named-previews` is the opt-in alternative for a project that must stay on the Workers free
plan at any traffic and serve every PR under its own domain. Each site is one **assets-only**
Worker you create once (static files, no `main`), with Previews enabled on it. Each pull request
becomes that Worker's named Preview `pr-<n>`, served at `pr-<n>.<host>` through your custom
domain, or at the Preview's own workers.dev URL while that domain's certificate is being issued.
No Worker script is deployed and no per-PR Worker is created: everything goes through
`createCloudflarePreviews` in the `mockingbird-preview` CLI.

```yaml
# .github/workflows/preview.yml
name: Preview
on:
  pull_request: { types: [opened, synchronize, reopened, closed] }
  push: { branches: [main] }        # optional: a `main` Preview, with a strict gate
  schedule: [{ cron: "17 4 * * *" }] # the sweep
  workflow_dispatch:                 # the sweep, by hand
permissions: { contents: read, pull-requests: write, deployments: write }
jobs:
  preview:
    uses: crvouga-organization/mockingbird/.github/workflows/preview.yml@main
    with:
      mode: named-previews
      host: preview.example.com
      sites: >-
        [{ "name": "app", "worker": "my-app-previews", "build": "bun run build", "outdir": "dist",
           "checks": "scripts/preview-checks.ts" },
         { "name": "storybook", "worker": "my-storybook-previews",
           "build": "bun run build-storybook", "outdir": "storybook-static" }]
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- **Several sites per PR.** `sites` is a JSON array of `{ name, worker?, build?, outdir?, config?,
  host?, checks? }` (missing fields fall back to the inputs of the same name; `worker` to `name`).
  Each site is its own matrix job, so they build and deploy concurrently and one failing does not
  cancel or hold back the others. Without `sites`, `name` / `build` / `outdir` /
  `wrangler-config` / `host` / `checks` make one site.
- **Assets only, refused otherwise.** A site's `config` (your Worker's `wrangler.json(c)`) may
  declare only static-file settings (`name`, `compatibility_date`, `assets.directory`,
  `assets.html_handling`, `assets.not_found_handling`, routes and similar). A `main`, any binding,
  a var or `assets.run_worker_first` fails the deploy before anything is uploaded, so a preview
  can never run billable Worker code. Its `compatibility_date` and asset handling are used for the
  Preview. A `_headers` file in `outdir` is kept; `_redirects` is refused.
- **Proof it is served.** After upload the CLI polls `version.json` (stamped with the commit) at
  the Preview's origin until it names the commit (`waitUntilServing`).
- **Your checks, before and after upload.** `checks` names a module whose default export is
  `(origin, fetch) => Promise<{ name, ok, detail? }[]>`. It runs first against the built
  directory (a gate; `fetch` reads the files), then against the deployed origin, re-read until it
  passes or the deadline passes, since the edge moves machine by machine. A pull request's gate is
  best effort: a failing one still uploads and the PR says **deployed, but failing its checks**. A
  branch's gate (a `push`) is strict: nothing is uploaded and the last passing deploy keeps
  serving.
- **The PR description.** The workflow owns one block between `<!-- preview:start -->` and
  `<!-- preview:end -->`, kept at the very top of the description: the status (deploying, live,
  deployed but failing its checks, failed, removed, expired), a link to every site, the deployed and
  attempted commits and the run. Text outside the block is never changed. A run that fails before
  upload marks it failed and keeps the previous deployed commit and links, which keep serving.
- **GitHub Deployments.** Each site's deploy is a Deployment in the transient environment
  `preview/<site>/pr-<n>`, `in_progress` then `success` or `failure`, with the run as `log_url`.
  Earlier deployments of the PR are marked inactive and deleted; closing the PR deletes them all.
- **Removal and the sweep.** Closing the PR deletes every site's Preview and confirms it gone. A
  missed close cannot leave an orphan forever: on `schedule` or `workflow_dispatch` the workflow
  runs `mockingbird-preview sweep` for every site's Worker, which removes `pr-<n>` Previews of
  closed PRs, those not deployed for `retention-days` (default 7) and the oldest beyond `capacity`
  (default 80), confirms each gone and fails if any is left. An open PR whose Preview expired says
  so in its description; pushing a commit deploys it again. Previews not named `pr-<n>` (a branch's)
  are never swept.

In `named-previews` mode the live status that needs a Worker script (`/__preview/*`: build and
checks status, Server-Sent Events) is **not available**: an assets-only Worker runs no code, and
`workflow_run` events are ignored. `version.json` is still stamped, so the boot loader's in-place
updates (its `/version.json` poll) keep working.

## Your own lifecycle

Driving Cloudflare Previews yourself instead of the workflow? The package exports pure helpers for the
same decisions. `explainPreviewAction(pullRequest, builtCommit)` deploys, removes, or skips with a
reason (`fork`, `stale-head`, `no-build`) and a message for your log or PR comment;
`selectBranchAction({ head }, builtCommit)` deploys the branch the Worker serves only from its
current head. `planPreviewSweep` lists previews to remove; pass `capacityCounts: "all"` to count
previews it does not manage against `capacity` too. See the
[package README](../packages/adapters/preview/README.md).

## What a preview does not do

- **Checks status starts once the caller file is on your default branch.** GitHub runs
  `workflow_run` from the default branch only.
- **A status change reaches open tabs within about 25 s.** It lands in a new Worker version,
  which an open SSE stream picks up when it reconnects; polling tabs see it on their next poll.
- **A new version starts a fresh app.** Anything your app keeps in memory is gone after an
  in-place update; what it keeps in `localStorage` stays.
