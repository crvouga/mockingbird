# Mockingbird Superset.sh Integration

This directory contains configuration and scripts for deep integration with the superset.sh harness.

## Quick Start

```bash
# Setup: install dependencies and verify environment
.superset/setup.sh

# Run: execute quality gates (CI replica)
.superset/run.sh check

# Run specific modes
.superset/run.sh test       # run tests
.superset/run.sh build      # build packages
.superset/run.sh docs       # build documentation
.superset/run.sh docs:dev   # start dev server
.superset/run.sh all        # full CI simulation

# Cleanup: remove artifacts
.superset/teardown.sh
```

## Configuration

**`config.json`** — superset.sh harness configuration

```json
{
  "setup": [".superset/setup.sh"],           // preparation
  "run": [".superset/run.sh check"],         // default run mode
  "teardown": [".superset/teardown.sh"],     // cleanup
  "env": { "TURBO_TEAM": "..." },            // environment
  "ports": { "docs-dev": 3000 },             // services
  "requirements": { "node": ">=22" },        // checks
  "commands": { "test": "...", ... }         // shortcuts
}
```

## Scripts

### `setup.sh`

**Initializes the workspace**

```bash
.superset/setup.sh
```

Does:
1. Verifies Node.js (≥22.0.0) and Bun (≥1.2.0)
2. Installs dependencies with `bun install --frozen-lockfile`
3. Generates documentation
4. Checks workspace boundaries

### `run.sh`

**Executes checks, tests, builds, or dev servers**

```bash
.superset/run.sh {mode} [verbose]
```

Modes:
- **`check`** — quality gates (lint, typecheck, format, boundaries)
- **`test`** — run test suites
- **`build`** — build packages (src → dist)
- **`docs`** — build static documentation site
- **`docs:dev`** — start documentation dev server (port 3000)
- **`parity`** — run live parity tests (requires credentials)
- **`all`** — check + build + test + docs (CI simulation)

Examples:
```bash
.superset/run.sh check              # Verify code quality
.superset/run.sh test               # Run tests
.superset/run.sh docs:dev           # Start docs server
.superset/run.sh all                # Full CI
```

### `teardown.sh`

**Cleans up build artifacts and temporary resources**

```bash
.superset/teardown.sh
```

By default removes:
- `packages/*/dist/`
- `sites/docs/dist`
- `.nyc_output` and `coverage/`
- Temporary files

Optional cleanups (set environment variables):
```bash
CLEAN_TURBO_CACHE=true .superset/teardown.sh    # Clear .turbo/
CLEAN_DEPENDENCIES=true .superset/teardown.sh   # Remove node_modules
```

## Environment

Configure via `config.json` `env` section:

```json
{
  "env": {
    "TURBO_TEAM": "chrisvouga",
    "TURBO_API": "https://turborepo.chrisvouga.dev",
    "NODE_OPTIONS": "--max-old-space-size=4096"
  }
}
```

Or set in shell:
```bash
export TURBO_TEAM=chrisvouga
export TURBO_API=https://turborepo.chrisvouga.dev
.superset/run.sh check
```

## Credentials

For live parity tests, set credentials in environment or Vault:

```bash
# Environment variables
export MOCKINGBIRD_STRIPE_SECRET_KEY="sk_test_..."
export MOCKINGBIRD_JUNCTION_API_KEY="sk_us_..."

# Or use Vault
bun run vault:login
bun run parity:stripe
```

See [docs/SECRETS.md](../docs/SECRETS.md) for setup.

## Integration with superset.sh

### Harness Execution

```bash
# superset.sh runs this sequence
superset setup                  # → .superset/setup.sh
superset run check             # → .superset/run.sh check
superset teardown              # → .superset/teardown.sh
```

### Commands

Shortcut commands defined in `config.json`:

```bash
superset test                  # → bun run test
superset build                 # → bun run build
superset docs:dev              # → bun run docs:dev
superset parity                # → bun run parity:service
```

### Service Discovery

Superset.sh reads from `config.json`:

```json
{
  "ports": {
    "docs-dev": 3000
  }
}
```

Allows:
```bash
superset open docs-dev         # Opens http://localhost:3000
```

### Requirements Checking

Superset.sh verifies before setup:

```json
{
  "requirements": {
    "node": ">=22.0.0",
    "bun": ">=1.2.0"
  }
}
```

Fails fast if versions are incompatible.

## CI/CD Integration

### GitHub Actions

Superset.sh integration in CI:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: crvouga/superset-action@v1
        with:
          mode: all  # run: setup → check → teardown
```

### Local Replica

Run full CI locally:

```bash
.superset/run.sh all
```

Replicates CI workflow without pushing:
1. Setup (install dependencies)
2. Check (lint, typecheck, format, boundaries)
3. Build (packages)
4. Test (suites)
5. Docs (static site)

## Debugging

### Verbose Output

```bash
.superset/run.sh check verbose
```

Shows detailed output for each check.

### Individual Steps

```bash
# Just lint
bun run lint

# Just typecheck
bun run typecheck

# Just tests
bun run test

# Just build
bun run build
```

### Troubleshooting

**Setup fails with version error:**
```bash
node --version   # Check >= 22.0.0
bun --version    # Check >= 1.2.0
```

**Tests fail with dependency error:**
```bash
rm -rf node_modules bun.lock
.superset/setup.sh
```

**Docs dev server won't start:**
```bash
lsof -i :3000    # Check if port is in use
kill -9 <PID>    # Kill process if needed
.superset/run.sh docs:dev
```

## Workspace Structure

```
.superset/
├── config.json           ← Harness configuration
├── setup.sh              ← Initialization script
├── run.sh                ← Execution script (check/test/build/docs)
├── teardown.sh           ← Cleanup script
└── README.md             ← This file
```

## Conventions

- **Scripts are idempotent** — safe to run multiple times
- **Errors cause early exit** — `set -e` in all scripts
- **Logs are human-readable** — clear section headers
- **Cleanup is safe** — removes only generated artifacts
- **Env vars are optional** — defaults work for most cases

## See Also

- [CLAUDE.md](../CLAUDE.md) — Agent-specific conventions
- [AGENTS.md](../AGENTS.md) — Agent command integration
- [docs/SECRETS.md](../docs/SECRETS.md) — Credential setup
- [docs/AUTHORING_A_SERVICE.md](../docs/AUTHORING_A_SERVICE.md) — Adding services
