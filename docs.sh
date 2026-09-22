#!/bin/bash
# Quick script to start the documentation dev server
# Usage: ./docs.sh or ./docs.sh build

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

MODE="${1:-dev}"

case "$MODE" in
  dev|start|watch)
    echo "🌐 Starting documentation dev server..."
    echo ""
    echo "📍 Generating documentation..."
    bun run docs:generate
    echo ""
    echo "🚀 Starting Astro dev server..."
    echo "   Open http://localhost:3000"
    echo ""
    bun run --cwd sites/docs dev
    ;;
  build)
    echo "📦 Building documentation site..."
    bun run docs:build
    echo ""
    echo "✅ Built to sites/docs/dist/"
    echo ""
    echo "To preview: ./docs.sh preview"
    ;;
  preview)
    echo "👁️  Previewing documentation build..."
    bun run --cwd sites/docs preview
    ;;
  generate)
    echo "📚 Generating documentation from code..."
    bun run docs:generate
    echo "✅ Generated catalog.json and compatibility.json"
    ;;
  *)
    echo "Usage: ./docs.sh {dev|build|preview|generate}"
    echo ""
    echo "Modes:"
    echo "  dev       - Start dev server (default, port 3000)"
    echo "  build     - Build static site to dist/"
    echo "  preview   - Preview built site"
    echo "  generate  - Generate catalog from service metadata"
    echo ""
    echo "Examples:"
    echo "  ./docs.sh              # Start dev server"
    echo "  ./docs.sh build        # Build static site"
    echo "  ./docs.sh preview      # Preview built site"
    exit 1
    ;;
esac
