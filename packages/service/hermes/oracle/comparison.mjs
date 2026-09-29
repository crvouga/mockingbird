/** Map only public identity fields and the exact pinned missing-run error template. */
export const normalizeObservation = (response, ids) => {
  const body = structuredClone(response.body)
  for (const field of ["run_id", "session_id"]) {
    if (typeof body[field] === "string" && ids.has(body[field])) body[field] = ids.get(body[field])
  }
  if (response.status === 404 && body.error?.code === "run_not_found") {
    for (const [id, name] of ids) {
      if (body.error.message === `Run not found: ${id}`) {
        body.error.message = `Run not found: ${name}`
        break
      }
    }
  }
  return { ...response, body }
}
