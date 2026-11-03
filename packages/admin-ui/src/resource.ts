/**
 * State behind `useResource`. A payload belongs to the source (api and path) that
 * fetched it. Polling the same source keeps the last good payload; switching to a new
 * source drops it, so a failed or slow request never shows another source's data.
 */
export type ResourceState<T> = {
  source: unknown
  data: T | null
  error: string | null
  loading: boolean
}

export type ResourceEvent<T> =
  | { type: "start"; source: unknown; foreground: boolean }
  | { type: "loaded"; source: unknown; value: T }
  | { type: "failed"; source: unknown; error: string }
  | { type: "settled"; source: unknown; foreground: boolean }

export const initialResource = <T>(source: unknown): ResourceState<T> => ({
  source,
  data: null,
  error: null,
  loading: true,
})

export function resourceReducer<T>(
  state: ResourceState<T>,
  event: ResourceEvent<T>,
): ResourceState<T> {
  if (event.type === "start") {
    if (!Object.is(event.source, state.source)) return initialResource<T>(event.source)
    return event.foreground ? { ...state, loading: true } : state
  }
  // A late reply from a source the view has left is ignored.
  if (!Object.is(event.source, state.source)) return state
  switch (event.type) {
    case "loaded":
      return { ...state, data: event.value, error: null }
    case "failed":
      return { ...state, error: event.error }
    case "settled":
      return event.foreground ? { ...state, loading: false } : state
  }
}

/** What a view may render for `source`. Before its first request starts, nothing is known. */
export const resourceFor = <T>(state: ResourceState<T>, source: unknown): ResourceState<T> =>
  Object.is(state.source, source) ? state : initialResource<T>(source)
