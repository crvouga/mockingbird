// Plain JS so tsc never loads (or type-infers) the multi-megabyte recording; esbuild inlines it.
export { default } from "../corpus/sandbox-sealed.json" with { type: "json" }
