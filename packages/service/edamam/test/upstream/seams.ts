/**
 * The Nest / platform seams of the copied adapters, replaced for tests: a config map, a logger
 * that records structured events, `logStructured`, and an injectable `fetch` + base URL.
 */
export type ConfigService = { get<T>(key: string): T | undefined }
export type LoggerService = { events: Record<string, unknown>[] }
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export const configOf = (values: Record<string, unknown>): ConfigService => ({
  get: <T>(key: string) => values[key] as T | undefined,
})

export const createLogger = (): LoggerService => ({ events: [] })

export const logStructured = (
  logger: LoggerService,
  level: string,
  event: Record<string, unknown>,
): void => {
  logger.events.push({ level, ...event })
}
