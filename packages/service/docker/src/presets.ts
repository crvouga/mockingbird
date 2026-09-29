import type { FaultPreset } from "@crvouga/mockingbird-service"

export const presets: Record<string, FaultPreset> = {}
for (const [name, operationId] of Object.entries({
  create: "ContainerCreate",
  start: "ContainerStart",
  stop: "ContainerStop",
  kill: "ContainerKill",
  remove: "ContainerDelete",
})) {
  presets[`docker_${name}_pre_failure`] = {
    description: `Reject ${name} before mutation`,
    rules: [
      { operationId, count: 1, status: 503, body: { message: "Injected failure before mutation" } },
    ],
  }
  presets[`docker_${name}_accepted_drop`] = {
    description: `Accept ${name}, then lose the response`,
    rules: [{ operationId, count: 1, effect: "docker.accepted_drop" }],
  }
}
