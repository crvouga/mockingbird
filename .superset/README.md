# Superset workspace lifecycle

[Superset](https://docs.superset.sh/setup-teardown-scripts) reads `.superset/config.json` and runs these scripts in the workspace directory.

| When | Script | What it does |
| --- | --- | --- |
| Workspace created | `./.superset/setup.sh` | Copies untracked files and `.env*` from `$SUPERSET_ROOT_PATH` (without overwriting), reserves a docs port, then `bun run setup` (install, build, create `.env.local`) |
| Run button | `./.superset/run.sh` | Builds the docs site's dependencies and starts `bun docs` on that port |
| Workspace deleted | `./.superset/teardown.sh` | Stops the dev server and releases the port |

The docs site (`sites/docs`, Astro) is the dev server. Its default port is 4321, so parallel workspaces would collide. Setup reserves one slot per workspace in `~/.superset/port-allocations.json` — 20-port slots aligned at 3000, the shared file described in the [port docs](https://docs.superset.sh/ports) — and serves the site on the base of that slot. The first free slot is usually port 3000. The server listens on `http://127.0.0.1:<port>`.

Setup also writes `.superset/ports.json` so Superset labels the listening port "Docs". `.superset/dev-port`, `.superset/dev-server.pid`, and `.superset/ports.json` are generated per workspace and gitignored.

Run the same scripts from a checkout without Superset:

```bash
./.superset/setup.sh
./.superset/run.sh
./.superset/teardown.sh
```

Outside a workspace, `SUPERSET_ROOT_PATH` is unset, so setup skips the copy, reserves a port and runs `bun run setup`.
