#!/bin/bash
# Mockingbird run script for superset.sh harness
# Executes checks, tests, and builds based on mode

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Parse arguments
MODE="${1:-check}"  # check, test, build, docs, all
VERBOSE="${2:-}"

function log_section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📍 $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

function run_check() {
  log_section "Quality Gates (format, lint, typecheck, tests)"
  bun run check
  echo "✅ All quality gates passed"
}

function run_test() {
  log_section "Running Test Suites"
  bun run test
  echo "✅ Tests passed"
}

function run_build() {
  log_section "Building Packages"
  bun run build
  echo "✅ Build complete"
}

function run_docs() {
  log_section "Building Documentation Site"
  bun run docs:build
  echo "✅ Docs built to sites/docs/dist/"
}

function run_docs_dev() {
  log_section "Starting Documentation Dev Server"
  echo "🌐 Opening http://localhost:3000"
  bun run docs:dev
}

function run_parity() {
  log_section "Running Live Parity Tests (requires credentials)"
  if [ -z "$MOCKINGBIRD_STRIPE_SECRET_KEY" ]; then
    echo "⚠️  MOCKINGBIRD_STRIPE_SECRET_KEY not set"
    echo "   See docs/SECRETS.md for credential setup"
    return 0
  fi

  bun run vault:login || echo "⚠️  Vault login failed (optional)"
  bun run parity:stripe
  echo "✅ Parity tests passed"
}

function run_all() {
  run_check
  run_build
  run_test
  run_docs

  log_section "Complete!"
  echo "✅ All checks, builds, tests, and docs passed"
  echo ""
  echo "Next: Push to GitHub for full CI/CD workflow"
}

# Main
case "$MODE" in
  check)
    run_check
    ;;
  test)
    run_test
    ;;
  build)
    run_build
    ;;
  docs)
    run_docs
    ;;
  docs:dev)
    run_docs_dev
    ;;
  parity)
    run_parity
    ;;
  all)
    run_all
    ;;
  *)
    echo "Usage: $0 {check|test|build|docs|docs:dev|parity|all}"
    echo ""
    echo "Modes:"
    echo "  check      - Format, lint, typecheck, boundaries (CI gates)"
    echo "  test       - Run test suites"
    echo "  build      - Build packages (src → dist)"
    echo "  docs       - Build documentation site (static HTML)"
    echo "  docs:dev   - Start documentation dev server"
    echo "  parity     - Run live parity tests (requires credentials)"
    echo "  all        - Run check, build, test, docs (CI replica)"
    echo ""
    echo "Examples:"
    echo "  .superset/run.sh check       # Verify code quality"
    echo "  .superset/run.sh test        # Run tests"
    echo "  .superset/run.sh docs:dev    # Start docs server"
    echo "  .superset/run.sh all         # Full CI simulation"
    exit 1
    ;;
esac
