import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type Secret = {
  name: string
  arn: string
  description?: string
  kmsKeyId?: string
  createdAt: number
  lastChangedAt: number
}
export type SecretVersion = {
  secretName: string
  id: string
  stages: string[]
  createdAt: number
  valueKind: "string" | "binary"
  encodedValue: string
}
export type Parameter = {
  name: string
  arn: string
  type: "String" | "StringList" | "SecureString"
  encodedValue: string
  version: number
  lastModifiedAt: number
  dataType: string
  keyId?: string
  description?: string
}
export type SecretControl = {
  denied: boolean
  staleVersionId?: string
  decryptionFailure?: boolean
}
export class AwsSecretsState {
  readonly secrets: Collection<Secret>
  readonly versions: Collection<SecretVersion>
  readonly parameters: Collection<Parameter>
  readonly controls: Collection<SecretControl>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.secrets = new Collection(sqlite, namespace, "aws_secrets")
    this.versions = new Collection(sqlite, namespace, "aws_secret_versions")
    this.parameters = new Collection(sqlite, namespace, "aws_parameters")
    this.controls = new Collection(sqlite, namespace, "aws_secret_controls")
    this.ids = new IdSequence(sqlite, namespace, "aws-secrets")
  }
}
