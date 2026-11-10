import { STYLES } from "./styles.js"

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The harness shell. Everything inside `#app` is drawn by `/ui.js`. */
export const renderPage = ({ title }: { title: string }): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)} · Mockingbird</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a84ff"/><path d="M9 13a7 7 0 0 1 14 0v5l2 3H7l2-3z" fill="#fff"/><circle cx="16" cy="24.5" r="2.5" fill="#fff"/></svg>',
)}">
<style>${STYLES}</style>
</head>
<body>
<div id="app" data-title="${escapeHtml(title)}"><div class="boot">Loading notifications…</div></div>
<script type="module" src="./ui.js"></script>
</body>
</html>`
