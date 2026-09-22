#!/bin/bash
# Mockingbird setup script for superset.sh harness
# Installs all dependencies and prepares the workspace

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -n "${SUPERSET_ROOT_PATH:-}" ] && [ "$SUPERSET_ROOT_PATH" != "$PROJECT_ROOT" ]; then
  # Copy untracked local files, including ignored .env files, without overwriting workspace files.
  while IFS= read -r -d '' path; do
    if [ -f "$SUPERSET_ROOT_PATH/$path" ] && [ ! -e "$PROJECT_ROOT/$path" ]; then
      mkdir -p "$PROJECT_ROOT/$(dirname "$path")"
      cp -p "$SUPERSET_ROOT_PATH/$path" "$PROJECT_ROOT/$path"
    fi
  done < <(git -C "$SUPERSET_ROOT_PATH" ls-files --others --exclude-standard -z)
  for source in "$SUPERSET_ROOT_PATH"/.env "$SUPERSET_ROOT_PATH"/.env.*; do
    [ -f "$source" ] || continue
    target="$PROJECT_ROOT/${source##*/}"
    [ -e "$target" ] || cp -p "$source" "$target"
  done
fi

echo "🔧 Setting up Mockingbird..."

# Check Node.js and Bun versions
echo "📋 Checking Node.js version (≥22.0.0)..."
node_version=$(node --version | cut -d'v' -f2)
if ! node -e "process.exit(require('semver').gte(process.version, '22.0.0') ? 0 : 1)" 2>/dev/null; then
  echo "⚠️  Node.js version $node_version is below required 22.0.0"
fi

echo "📋 Checking Bun version (≥1.2.0)..."
bun_version=$(bun --version)
echo "   Bun $bun_version"

# Install dependencies with frozen lockfile
echo "📦 Installing dependencies with Bun..."
bun install --frozen-lockfile

# Verify lockfile is committed
if git diff-index --quiet HEAD -- bun.lock; then
  echo "✓ bun.lock is up to date"
else
  echo "⚠️  bun.lock has changes - dependencies may be out of sync"
fi

# Verify workspace integrity
echo "🔍 Checking workspace boundaries..."
bun run check:boundaries 2>&1 || {
  echo "⚠️  Workspace boundary check failed"
  exit 1
}

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  bun run check          # Run all quality gates"
echo "  bun run test           # Run test suites"
echo "  bun docs               # Build the services, then start the docs dev server"
echo "  bun run parity:stripe  # Run live parity tests (with credentials)"
