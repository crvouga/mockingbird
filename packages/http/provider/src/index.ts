import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"
import { type APIOptions, bootSqlite, requestBaseUrl } from "@crvouga/mockingbird-service"
import { clearNamespace, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import { useRandom, withRandom } from "./vendor/core/crypto.js"
import {
  type AppEnv,
  cors,
  Hono,
  type ServicePlugin,
  Store,
  WebhookDispatcher,
} from "./vendor/core/index.js"
import {
  type AuthFallback,
  type AuthUser,
  authMiddleware,
  restoreTokenMap,
  serializeTokenMap,
  type TokenEntry,
} from "./vendor/core/middleware/auth.js"
import {
  createApiErrorHandler,
  createErrorHandler,
} from "./vendor/core/middleware/error-handler.js"
import { createAppKeyResolver } from "./vendor/github/index.js"

export type ProviderOptions = APIOptions & {
  baseUrl?: string
  tokens?: Record<string, AuthUser>
  fallbackUser?: AuthFallback
  publicNamespace?: string
  adminPrefix?: string
  /**
   * A seeded stream of `[0, 1)` that ids and tokens are minted from, so a run replays from
   * its seed. Default: the platform's randomness.
   */
  random?: () => number
}

const fallbackUsers: Record<string, AuthFallback> = {
  github: { login: "admin", id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] },
  slack: { login: "U000000001", id: 1, scopes: [] },
  aws: { login: "admin", id: 1, scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"] },
  resend: { login: "re_test_admin", id: 1, scopes: [] },
  stripe: { login: "sk_test_admin", id: 1, scopes: [] },
  twilio: { login: "AC00000000000000000000000000000000", id: 1, scopes: [] },
  vercel: { login: "admin", id: 1, scopes: [] },
  google: { login: "testuser@gmail.com", id: 1, scopes: ["openid", "email", "profile"] },
  apple: { login: "testuser@icloud.com", id: 1, scopes: ["openid", "email", "name"] },
  microsoft: {
    login: "testuser@outlook.com",
    id: 1,
    scopes: ["openid", "email", "profile", "User.Read"],
  },
  okta: { login: "testuser@okta.local", id: 1, scopes: ["openid", "profile", "email", "groups"] },
  mongoatlas: { login: "admin", id: 1, scopes: [] },
  clerk: { login: "test@example.com", id: 1, scopes: [] },
  linear: { login: "admin@linear.local", id: 1, scopes: [] },
}

/** Portable vendor API backed by the shared namespace; it owns no separate history or listener. */
export class ProviderAPI {
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly store: Store
  private activeApp: Hono<AppEnv>
  private activeBaseUrl: string
  private readonly facade = new Hono<AppEnv>().use("*", (c) => this.fetch(c.req.raw))
  get app(): Hono<AppEnv> {
    return this.facade
  }
  get routeTable() {
    return this.activeApp.routeTable
  }
  readonly tokenMap = new Map<string, AuthUser>()
  readonly webhooks: WebhookDispatcher
  private configured:
    | { config: unknown; apply: (store: Store, baseUrl: string, config: never) => void }
    | undefined
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    readonly plugin: ServicePlugin,
    readonly options: ProviderOptions = {},
  ) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? plugin.name
    this.store = new Store(this.sqlite, this.namespace, options.now ?? Date.now)
    this.webhooks = new WebhookDispatcher({ store: this.store })
    this.activeBaseUrl = options.baseUrl ?? "http://mock.local"
    this.activeApp = this.buildApp(this.activeBaseUrl)
    if (!this.store.meta.get("initialized")) this.initialize()
  }
  private buildApp(baseUrl: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>()
    // Whatever this request mints comes from this instance's stream, not the last caller's.
    app.use("*", async (_c, next) => {
      useRandom(this.options.random)
      await next()
    })
    const docs = `https://docs.mockingbird.dev/services/${this.plugin.name}`
    app.onError(createApiErrorHandler(docs))
    app.use("*", cors())
    app.use("*", createErrorHandler(docs))
    app.use(
      "*",
      authMiddleware(
        this.tokenMap,
        this.plugin.name === "github" ? createAppKeyResolver(this.store) : undefined,
        this.options.fallbackUser ?? fallbackUsers[this.plugin.name],
        this.store.now,
      ),
    )
    this.plugin.register(app, this.store, this.webhooks, baseUrl, this.tokenMap)
    app.notFound((c) => c.json({ message: "Not Found", documentation_url: docs }, 404))
    return app
  }
  private initialize(): void {
    withRandom(this.options.random, () =>
      this.plugin.seed?.(this.store, this.options.baseUrl ?? this.activeBaseUrl),
    )
    for (const [token, user] of Object.entries(this.options.tokens ?? {}))
      this.tokenMap.set(token, user)
    this.store.setData("tokens", serializeTokenMap(this.tokenMap))
    this.store.meta.insert("initialized", true)
    this.store.flush()
  }
  /** Persist seed configuration before the shared runtime captures its initial checkpoint. */
  seed(config: unknown, apply: (store: Store, baseUrl: string, config: never) => void): void {
    withRandom(this.options.random, () =>
      apply(this.store, this.options.baseUrl ?? this.activeBaseUrl, config as never),
    )
    this.store.flush()
  }
  configureFixtures(
    config: unknown,
    apply: (store: Store, baseUrl: string, config: never) => void,
  ): void {
    this.configured = { config, apply }
    if (!this.store.meta.has("configured-fixtures")) {
      this.seed(config, apply)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
  fetch(request: Request): Promise<Response> {
    const run = async () => {
      if (!this.options.baseUrl) {
        const namespace = this.options.publicNamespace
        const baseUrl =
          requestBaseUrl(request) +
          (namespace && namespace !== "default"
            ? `${this.options.adminPrefix ?? "/__admin"}/ns/${encodeURIComponent(namespace)}`
            : "")
        if (baseUrl !== this.activeBaseUrl) {
          this.activeBaseUrl = baseUrl
          this.activeApp = this.buildApp(baseUrl)
        }
      }
      this.store.begin()
      if (!this.store.meta.get("initialized")) {
        this.tokenMap.clear()
        this.webhooks.clear()
        this.initialize()
      }
      restoreTokenMap(this.tokenMap, this.store.getData<TokenEntry[]>("tokens") ?? [])
      try {
        return await this.activeApp.fetch(request)
      } finally {
        this.store.setData("tokens", serializeTokenMap(this.tokenMap))
        this.store.flush()
      }
    }
    const result = this.tail.then(run, run)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  async reset(): Promise<void> {
    await this.tail
    // Signing identity is fixture configuration: clearing records must not invalidate
    // an app's cached JWKS. It still lives in SQLite and follows snapshot restoration.
    const signingId = `${this.plugin.name}.oauth.signingKeys`
    const signingKeys = this.store.getData(signingId)
    clearNamespace(this.sqlite, this.namespace)
    this.store.reset()
    this.tokenMap.clear()
    this.webhooks.clear()
    this.initialize()
    if (signingKeys !== undefined) {
      this.store.setData(signingId, signingKeys)
      this.store.flush()
    }
    if (this.configured) this.configureFixtures(this.configured.config, this.configured.apply)
  }
}

export function providerDocument(
  name: string,
  origin: string,
  routes: readonly string[],
): OpenAPIDocument {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of routes) {
    const separator = route.indexOf(" ")
    const method = route.slice(0, separator).toLowerCase()
    const source = route.slice(separator + 1)
    if (source.startsWith("/_emulate")) continue
    const path = source.replace(/:([\w]+)(?:\{[^}]*\})?/g, "{$1}")
    const parameters = [...path.matchAll(/\{([\w]+)\}/g)].map((match) => ({
      in: "path",
      name: match[1],
      required: true,
      schema: { type: "string" },
    }))
    paths[path] ??= {}
    const group = paths[path]
    group[method] = {
      operationId: `${method.toUpperCase()} ${source}`,
      summary: `${method.toUpperCase()} ${source}`,
      "x-mockingbird": {
        supported: true,
        ...(/:([\w]+)\{\.\+\}$/.test(source)
          ? { path: { parameter: /:([\w]+)\{\.\+\}$/.exec(source)?.[1] } }
          : {}),
        parity: {
          enabled: false,
          safe: false,
          reason:
            "Verified against a pinned package oracle; independent live vendor evidence is not available.",
        },
      },
      parameters,
      responses: {
        default: {
          description:
            "Provider response. Exact behavior is exercised against the pinned package oracle; not independently vendor-verified.",
        },
      },
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `${name} API`,
      version: "0.1.0",
      description:
        "Synthetic public vendor API. Licensed route ports; native SQLite namespaces and runtime controls.",
    },
    servers: [{ url: origin }],
    paths,
  } as OpenAPIDocument
}

const signature = (path: string) =>
  path.replace(/\{[^}]*\}|:[\w]+(?:\{[^}]*\})?/g, "#").replace(/\/$/, "")

/** Add vendor operations while retaining independently implemented native operations. */
export function expandDocument(
  legacy: OpenAPIDocument,
  routes: readonly string[],
): OpenAPIDocument {
  const extra = providerDocument(
    legacy.info.title,
    legacy.servers?.[0]?.url ?? "http://mock.local",
    routes,
  )
  const paths = structuredClone(legacy.paths)
  const old = listOperations(legacy)
  for (const operation of listOperations(extra)) {
    const existing = old.find(
      (other) =>
        other.method === operation.method && signature(other.path) === signature(operation.path),
    )
    if (existing && operationMetadata(existing.operation).supported) continue
    if (existing) delete paths[existing.path]?.[existing.method]
    paths[operation.path] ??= {}
    const group = paths[operation.path]
    group[operation.method] = operation.operation
  }
  return { ...legacy, paths }
}

/** Keep the independently implemented operation registry bound to its portion of the contract. */
export function selectOperations(
  document: OpenAPIDocument,
  ids: readonly string[],
): OpenAPIDocument {
  const paths: OpenAPIDocument["paths"] = {}
  for (const operation of listOperations(document)) {
    if (!ids.includes(operation.operationId)) continue
    paths[operation.path] ??= {}
    const group = paths[operation.path]
    group[operation.method] = operation.operation
    const shared = document.paths[operation.path]?.parameters
    if (shared) group.parameters = shared
  }
  return { ...document, paths }
}

function pathPattern(path: string, greedy?: string): RegExp {
  const parts = path
    .split(/(\{[^}]+\})/)
    .map((part) =>
      /^\{[^}]+\}$/.test(part)
        ? part === `{${greedy}}`
          ? ".+"
          : "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
  return new RegExp(`^${parts.join("")}/?$`)
}

export class ProviderExpansion extends ProviderAPI {
  private readonly legacyRoutes: { method: string; pattern: RegExp; specificity: number }[]
  private readonly extraRoutes: { method: string; pattern: RegExp; specificity: number }[]
  constructor(plugin: ServicePlugin, legacy: OpenAPIDocument, options: ProviderOptions = {}) {
    super(plugin, options)
    this.legacyRoutes = listOperations(legacy)
      .filter((operation) => operationMetadata(operation.operation).supported)
      .map((operation) => ({
        method: operation.method.toUpperCase(),
        specificity: operation.path.split("/").filter((part) => part && !part.includes("{")).length,
        pattern: pathPattern(
          operation.path,
          operationMetadata(operation.operation).path?.parameter,
        ),
      }))
    this.extraRoutes = this.routeTable.map((route) => ({
      method: route.method,
      specificity: route.path.split("/").filter((part) => part && !part.includes(":")).length,
      pattern: pathPattern(
        route.path.replace(/:([\w]+)(?:\{[^}]*\})?/g, "{$1}"),
        /:([\w]+)\{\.\+\}/.exec(route.path)?.[1],
      ),
    }))
  }
  legacyHandles(request: Request): boolean {
    const path = new URL(request.url).pathname
    return this.legacyRoutes.some(
      (route) => route.method === request.method.toUpperCase() && route.pattern.test(path),
    )
  }
  handles(request: Request): boolean {
    const path = new URL(request.url).pathname
    const method = request.method.toUpperCase()
    const best = (routes: typeof this.legacyRoutes) =>
      Math.max(
        -1,
        ...routes
          .filter((route) => route.method === method && route.pattern.test(path))
          .map((route) => route.specificity),
      )
    const extra = best(this.extraRoutes)
    return extra >= 0 && extra > best(this.legacyRoutes)
  }
}

export {
  type AppleSeedConfig,
  applePlugin,
  seedFromConfig as seedApple,
} from "./vendor/apple/index.js"
export { type AwsSeedConfig, awsPlugin, seedFromConfig as seedAws } from "./vendor/aws/index.js"
export { getAwsStore } from "./vendor/aws/store.js"
export {
  type ClerkSeedConfig,
  clerkPlugin,
  seedFromConfig as seedClerk,
} from "./vendor/clerk/index.js"
export { formatPullRequest, formatRepo, generateNodeId } from "./vendor/github/helpers.js"
export type {
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  GitHubSeedConfig,
} from "./vendor/github/index.js"
export {
  githubPlugin,
  type MaterializedGitHubSeedConfig,
  materializeGitHubSeedConfig,
  seedFromConfig as seedGithub,
} from "./vendor/github/index.js"
export type { GitHubStore } from "./vendor/github/store.js"
export { getGitHubStore } from "./vendor/github/store.js"
export {
  type GoogleSeedConfig,
  googlePlugin,
  seedFromConfig as seedGoogle,
} from "./vendor/google/index.js"
export {
  type LinearSeedConfig,
  linearPlugin,
  seedFromConfig as seedLinear,
} from "./vendor/linear/index.js"
export {
  type MicrosoftSeedConfig,
  microsoftPlugin,
  seedFromConfig as seedMicrosoft,
} from "./vendor/microsoft/index.js"
export {
  type MongoAtlasSeedConfig,
  mongoatlasPlugin,
  seedFromConfig as seedMongoatlas,
} from "./vendor/mongoatlas/index.js"
export { type OktaSeedConfig, oktaPlugin, seedFromConfig as seedOkta } from "./vendor/okta/index.js"
export {
  type ResendSeedConfig,
  resendPlugin,
  seedFromConfig as seedResend,
} from "./vendor/resend/index.js"
export type { ResendStore } from "./vendor/resend/store.js"
export { getResendStore } from "./vendor/resend/store.js"
export type { SlackMessage as ProviderSlackMessage } from "./vendor/slack/entities.js"
export { formatSlackView } from "./vendor/slack/helpers.js"
export type { SlackSeedConfig } from "./vendor/slack/index.js"
export { seedFromConfig as seedSlack, slackPlugin } from "./vendor/slack/index.js"
export type { SlackStore } from "./vendor/slack/store.js"
export { getSlackStore } from "./vendor/slack/store.js"
export { formatMessage as formatTwilioMessage } from "./vendor/twilio/formatters.js"
export {
  seedFromConfig as seedTwilio,
  type TwilioSeedConfig,
  twilioPlugin,
} from "./vendor/twilio/index.js"
export type { TwilioStore } from "./vendor/twilio/store.js"
export { getTwilioStore } from "./vendor/twilio/store.js"
export {
  seedFromConfig as seedVercel,
  type VercelSeedConfig,
  vercelPlugin,
} from "./vendor/vercel/index.js"
