#!/bin/bash
# Mockingbird teardown script for superset.sh harness
# Cleans up build artifacts and temporary resources

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "🧹 Cleaning up Mockingbird..."

# Clean build artifacts
echo "📦 Removing dist/ directories..."
find "$PROJECT_ROOT/packages" -type d -name "dist" -exec rm -rf {} + 2>/dev/null || true

# Clean docs build
echo "📚 Removing docs build..."
rm -rf "$PROJECT_ROOT/sites/docs/dist" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/sites/docs/.astro" 2>/dev/null || true

# Clean test artifacts
echo "🧪 Removing test coverage..."
rm -rf "$PROJECT_ROOT/.nyc_output" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/coverage" 2>/dev/null || true

# Clean Turbo cache (optional - local only)
if [ "$CLEAN_TURBO_CACHE" = "true" ]; then
  echo "⚙️  Clearing Turbo cache..."
  rm -rf "$PROJECT_ROOT/.turbo" 2>/dev/null || true
fi

# Clean node_modules (optional - full clean)
if [ "$CLEAN_DEPENDENCIES" = "true" ]; then
  echo "📦 Removing node_modules (this will require reinstall)..."
  rm -rf "$PROJECT_ROOT/node_modules" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/bun.lock.backup" 2>/dev/null || true
fi

# Clean temporary files
echo "🗑️  Removing temporary files..."
find "$PROJECT_ROOT" -type f -name "*.tmp" -delete 2>/dev/null || true
find "$PROJECT_ROOT" -type f -name ".DS_Store" -delete 2>/dev/null || true

# Report results
echo ""
echo "✅ Cleanup complete!"
echo ""
echo "Cleaned directories:"
echo "  • packages/*/dist/"
echo "  • sites/docs/dist"
echo "  • .nyc_output"
echo "  • coverage"
echo ""
if [ "$CLEAN_TURBO_CACHE" = "true" ]; then
  echo "  • .turbo (cache cleared)"
fi
if [ "$CLEAN_DEPENDENCIES" = "true" ]; then
  echo "  • node_modules (removed - run 'bun install' to restore)"
fi
echo ""
echo "To restore: bun install && bun run build"
