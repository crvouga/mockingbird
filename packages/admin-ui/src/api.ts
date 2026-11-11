import type { AdminApiConfig, AdminFetch, Api } from "./model.js"
import { isRecord } from "./model.js"

export const createApi = (
  config: Pick<AdminApiConfig, "adminPrefix" | "adminKeyHeader">,
  fetcher: AdminFetch,
  namespace: string,
  key: string,
): Api => {
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const headers = new Headers({
      accept: "application/json",
      "x-mockingbird-namespace": namespace,
    })
    if (key) headers.set(config.adminKeyHeader, key)
    if (body !== undefined) headers.set("content-type", "application/json")
    const response = await fetcher(
      `${config.adminPrefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      },
    )
    const raw = await response.text()
    let value: unknown
    try {
      value = raw ? JSON.parse(raw) : null
    } catch {
      value = raw
    }
    if (!response.ok) {
      const detail = isRecord(value)
        ? isRecord(value.error)
          ? value.error.message
          : value.error
        : undefined
      throw new Error(
        typeof detail === "string"
          ? detail
          : `${response.status} ${response.statusText || "Request failed"}`,
      )
    }
    return value as T
  }
  return {
    get: <T>(path: string, signal?: AbortSignal) => call<T>("GET", path, undefined, signal),
    send: <T>(method: string, path: string, body?: unknown) => call<T>(method, path, body),
    namespace: () => namespace,
  }
}
