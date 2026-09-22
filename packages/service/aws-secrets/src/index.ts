import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import { AwsSecretsState, type Parameter, type Secret, type SecretVersion } from "./state.js"

export type { AwsSecretsRuntime, AwsSecretsRuntimeOptions } from "./runtime.js"
export { AWS_SECRETS_PRESETS, createRuntime } from "./runtime.js"
export type { Parameter, Secret, SecretControl, SecretVersion } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const AWS_SECRETS_NAMESPACE = "aws-secrets"
export const accessKeyCredential = sigV4AccessKeyId
export type SecretSeed = {
  name: string
  value: string | Uint8Array
  binary?: boolean
  description?: string
  kmsKeyId?: string
}
export type ParameterSeed = {
  name: string
  value: string
  type?: Parameter["type"]
  dataType?: string
  keyId?: string
  description?: string
}
export type AwsSecretsAPIOptions = APIOptions & {
  region?: string
  accountId?: string
  secrets?: readonly SecretSeed[]
  parameters?: readonly ParameterSeed[]
  deniedNames?: readonly string[]
}
type Input = Record<string, unknown>

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const base64 = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const unbase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const encodeString = (value: string) => base64(encoder.encode(value))
const decodeString = (value: string) => decoder.decode(unbase64(value))

export class AwsSecretsAPI {
  readonly state: AwsSecretsState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly region: string
  private readonly accountId: string
  constructor(private readonly options: AwsSecretsAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? AWS_SECRETS_NAMESPACE
    this.now = options.now ?? Date.now
    this.region = options.region ?? "us-east-1"
    this.accountId = options.accountId ?? "000000000000"
    this.state = new AwsSecretsState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    for (const secret of this.options.secrets ?? [])
      if (!this.state.secrets.has(secret.name))
        this.createSecret({
          Name: secret.name,
          ...(secret.binary
            ? {
                SecretBinary: base64(
                  typeof secret.value === "string" ? encoder.encode(secret.value) : secret.value,
                ),
              }
            : {
                SecretString:
                  typeof secret.value === "string" ? secret.value : decoder.decode(secret.value),
              }),
          ...(secret.description ? { Description: secret.description } : {}),
          ...(secret.kmsKeyId ? { KmsKeyId: secret.kmsKeyId } : {}),
        })
    for (const parameter of this.options.parameters ?? [])
      if (!this.state.parameters.has(parameter.name))
        this.putParameter({
          Name: parameter.name,
          Value: parameter.value,
          Type: parameter.type ?? "String",
          ...(parameter.dataType ? { DataType: parameter.dataType } : {}),
          ...(parameter.keyId ? { KeyId: parameter.keyId } : {}),
          ...(parameter.description ? { Description: parameter.description } : {}),
        })
    for (const name of this.options.deniedNames ?? [])
      this.state.controls.insert(name, { denied: true })
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  private response(body: unknown, status = 200) {
    const id = this.state.ids.next("req-", 20)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amzn-requestid": id },
    })
  }
  private error(type: string, message: string, status = 400) {
    return this.response({ __type: type, message }, status)
  }
  private secret(id: unknown) {
    if (typeof id !== "string") return undefined
    return (
      this.state.secrets.get(id) ??
      this.state.secrets.list({ where: (secret) => secret.arn === id }).map(({ value }) => value)[0]
    )
  }
  private denied(name: string) {
    return this.state.controls.get(name)?.denied === true
  }
  private arn(kind: "secret" | "parameter", name: string) {
    return kind === "secret"
      ? `arn:aws:secretsmanager:${this.region}:${this.accountId}:secret:${name}-${this.state.ids.next("arn", 6)}`
      : `arn:aws:ssm:${this.region}:${this.accountId}:parameter${name.startsWith("/") ? name : `/${name}`}`
  }
  private versions(name: string) {
    return this.state.versions
      .list({ where: (version) => version.secretName === name, order: "oldest" })
      .map(({ value }) => value)
  }
  private newVersion(secret: Secret, input: Input) {
    const id =
      typeof input.ClientRequestToken === "string"
        ? input.ClientRequestToken
        : this.state.ids.next("ver-", 32)
    const existing = this.state.versions.get(`${secret.name}:${id}`)
    if (existing) return existing
    const binary = typeof input.SecretBinary === "string"
    const raw = binary
      ? (input.SecretBinary as string)
      : typeof input.SecretString === "string"
        ? encodeString(input.SecretString)
        : undefined
    if (!raw) throw new TypeError("SecretString or SecretBinary is required")
    const requested = Array.isArray(input.VersionStages)
      ? input.VersionStages.map(String)
      : ["AWSCURRENT"]
    if (requested.includes("AWSCURRENT")) {
      for (const version of this.versions(secret.name)) {
        const stages = version.stages.filter(
          (stage) => stage !== "AWSCURRENT" && stage !== "AWSPREVIOUS",
        )
        if (version.stages.includes("AWSCURRENT")) stages.push("AWSPREVIOUS")
        this.state.versions.insert(`${secret.name}:${version.id}`, { ...version, stages })
      }
    }
    const version: SecretVersion = {
      secretName: secret.name,
      id,
      stages: requested,
      createdAt: this.now(),
      valueKind: binary ? "binary" : "string",
      encodedValue: raw,
    }
    this.state.versions.insert(`${secret.name}:${id}`, version)
    this.state.secrets.insert(secret.name, { ...secret, lastChangedAt: this.now() })
    return version
  }
  private createSecret(input: Input) {
    const name = String(input.Name ?? "")
    if (!name) throw new TypeError("Name is required")
    if (this.state.secrets.has(name))
      throw new RangeError("A resource with the ID you requested already exists.")
    const secret: Secret = {
      name,
      arn: this.arn("secret", name),
      createdAt: this.now(),
      lastChangedAt: this.now(),
      ...(typeof input.Description === "string" ? { description: input.Description } : {}),
      ...(typeof input.KmsKeyId === "string" ? { kmsKeyId: input.KmsKeyId } : {}),
    }
    this.state.secrets.insert(name, secret)
    const version = this.newVersion(secret, input)
    return { ARN: secret.arn, Name: name, VersionId: version.id }
  }
  private putParameter(input: Input) {
    const name = String(input.Name ?? "")
    const value = input.Value
    if (!name || typeof value !== "string") throw new TypeError("Name and Value are required")
    const prior = this.state.parameters.get(name)
    if (prior && input.Overwrite !== true) throw new RangeError("The parameter already exists.")
    const type = (input.Type ?? prior?.type ?? "String") as Parameter["type"]
    const parameter: Parameter = {
      name,
      arn: prior?.arn ?? this.arn("parameter", name),
      type,
      encodedValue: encodeString(value),
      version: (prior?.version ?? 0) + 1,
      lastModifiedAt: this.now(),
      dataType: typeof input.DataType === "string" ? input.DataType : (prior?.dataType ?? "text"),
      ...(typeof input.KeyId === "string"
        ? { keyId: input.KeyId }
        : prior?.keyId
          ? { keyId: prior.keyId }
          : {}),
      ...(typeof input.Description === "string"
        ? { description: input.Description }
        : prior?.description
          ? { description: prior.description }
          : {}),
    }
    this.state.parameters.insert(name, parameter)
    return { Version: parameter.version, Tier: "Standard" }
  }
  private visibleParameter(parameter: Parameter, decrypt: boolean) {
    return {
      Name: parameter.name,
      Type: parameter.type,
      Value:
        parameter.type === "SecureString" && !decrypt
          ? `AQICAH${parameter.encodedValue.slice(0, 24)}`
          : decodeString(parameter.encodedValue),
      Version: parameter.version,
      LastModifiedDate: parameter.lastModifiedAt / 1000,
      ARN: parameter.arn,
      DataType: parameter.dataType,
    }
  }
  rotate(name: string, value: string | Uint8Array, binary = false) {
    const secret = this.state.secrets.get(name)
    if (!secret) return undefined
    return this.newVersion(
      secret,
      binary
        ? { SecretBinary: base64(typeof value === "string" ? encoder.encode(value) : value) }
        : { SecretString: typeof value === "string" ? value : decoder.decode(value) },
    )
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return this.error("InvalidRequestException", "Only POST is supported")
    const target = request.headers.get("x-amz-target") ?? ""
    const operation = target.split(".").at(-1) ?? ""
    const input = (await request.json().catch(() => ({}))) as Input
    try {
      if (target.startsWith("secretsmanager") || target.startsWith("SecretsManager")) {
        if (operation === "CreateSecret") return this.response(this.createSecret(input))
        const secret = this.secret(input.SecretId)
        if (!secret)
          return this.error(
            "ResourceNotFoundException",
            "Secrets Manager can't find the specified secret.",
          )
        if (this.denied(secret.name))
          return this.error(
            "AccessDeniedException",
            "User is not authorized to perform this action",
            400,
          )
        if (operation === "PutSecretValue") {
          const version = this.newVersion(secret, input)
          return this.response({
            ARN: secret.arn,
            Name: secret.name,
            VersionId: version.id,
            VersionStages: version.stages,
          })
        }
        if (operation === "DescribeSecret")
          return this.response({
            ARN: secret.arn,
            Name: secret.name,
            Description: secret.description,
            KmsKeyId: secret.kmsKeyId,
            CreatedDate: secret.createdAt / 1000,
            LastChangedDate: secret.lastChangedAt / 1000,
            VersionIdsToStages: Object.fromEntries(
              this.versions(secret.name).map((version) => [version.id, version.stages]),
            ),
          })
        if (operation === "GetSecretValue") {
          const control = this.state.controls.get(secret.name)
          if (control?.decryptionFailure)
            return this.error(
              "DecryptionFailure",
              "Secrets Manager can't decrypt the protected secret text using the provided KMS key.",
            )
          const requestedId =
            typeof input.VersionId === "string" ? input.VersionId : control?.staleVersionId
          const stage =
            typeof input.VersionStage === "string"
              ? input.VersionStage
              : requestedId
                ? undefined
                : "AWSCURRENT"
          const version = this.versions(secret.name).find((candidate) =>
            requestedId ? candidate.id === requestedId : candidate.stages.includes(stage as string),
          )
          if (!version || (requestedId && stage && !version.stages.includes(stage)))
            return this.error(
              "ResourceNotFoundException",
              "Secrets Manager can't find the specified secret value.",
            )
          return this.response({
            ARN: secret.arn,
            Name: secret.name,
            VersionId: version.id,
            VersionStages: version.stages,
            CreatedDate: version.createdAt / 1000,
            ...(version.valueKind === "string"
              ? { SecretString: decodeString(version.encodedValue) }
              : { SecretBinary: version.encodedValue }),
          })
        }
      }
      if (target.startsWith("AmazonSSM")) {
        if (operation === "PutParameter") {
          try {
            return this.response(this.putParameter(input))
          } catch (error) {
            if (error instanceof RangeError)
              return this.error("ParameterAlreadyExists", error.message)
            throw error
          }
        }
        if (operation === "GetParameter") {
          const name = String(input.Name ?? "")
          const parameter = this.state.parameters.get(name)
          if (!parameter) return this.error("ParameterNotFound", `Parameter ${name} not found.`)
          if (this.denied(name))
            return this.error(
              "AccessDeniedException",
              "User is not authorized to perform this action",
            )
          return this.response({
            Parameter: this.visibleParameter(parameter, input.WithDecryption === true),
          })
        }
        if (operation === "GetParameters") {
          const parameters: ReturnType<AwsSecretsAPI["visibleParameter"]>[] = []
          const invalid: string[] = []
          for (const name of Array.isArray(input.Names) ? input.Names.map(String) : []) {
            const parameter = this.state.parameters.get(name)
            if (parameter && !this.denied(name))
              parameters.push(this.visibleParameter(parameter, input.WithDecryption === true))
            else invalid.push(name)
          }
          return this.response({ Parameters: parameters, InvalidParameters: invalid })
        }
      }
      return this.error("InvalidRequestException", `Unknown operation ${operation}`)
    } catch (error) {
      if (error instanceof RangeError) return this.error("ResourceExistsException", error.message)
      return this.error(
        "InvalidRequestException",
        error instanceof Error ? error.message : "Invalid request",
      )
    }
  }
}
