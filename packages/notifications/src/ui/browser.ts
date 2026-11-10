/// <reference lib="dom" />
/** The harness page's entry: mount the live UI on `#app`. */
import { createApp } from "./app.js"

createApp(document.getElementById("app") as HTMLElement, { live: true })
