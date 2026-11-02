import type { RuntimeOptions, ServiceInstance, ServiceRuntime } from "@crvouga/mockingbird-service"
export type ServiceName =
  | "vercel"
  | "github"
  | "google"
  | "slack"
  | "apple"
  | "microsoft"
  | "okta"
  | "aws"
  | "resend"
  | "stripe"
  | "mongoatlas"
  | "clerk"
  | "linear"
  | "twilio"
export const nativeProviders = [
  "vercel",
  "github",
  "slack",
  "aws",
  "resend",
  "stripe",
  "twilio",
  "google",
  "apple",
  "microsoft",
  "okta",
  "mongoatlas",
  "clerk",
  "linear",
] as const
export type NativeProvider = (typeof nativeProviders)[number]
export async function target(
  name: (typeof nativeProviders)[number],
  baseUrl: string,
  options: TargetOptions = {},
) {
  const module = (await import(`../../../service/${name}/src/index.ts`)) as {
    createRuntime(options?: { baseUrl?: string } & TargetOptions): ServiceRuntime<ServiceInstance>
  }
  return module.createRuntime({ baseUrl, ...options })
}

type TargetOptions = Pick<RuntimeOptions<ServiceInstance>, "clock" | "seed"> & {
  fixtures?: unknown
}
