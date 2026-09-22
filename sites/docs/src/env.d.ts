declare module "virtual:mockingbird/catalog" {
  const catalog: import("./lib/types.ts").Catalog
  export default catalog
}

declare module "virtual:mockingbird/runtimes" {
  // biome-ignore lint/suspicious/noExplicitAny: each service module has its own export shape.
  export const loaders: Record<string, () => Promise<any>>
}

declare module "virtual:mockingbird/examples" {
  export const exampleLoaders: Record<string, () => Promise<import("./lib/types.ts").ExampleModule>>
}
