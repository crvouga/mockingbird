/**
 * The effective AccessPolicy of a login, ported from packages/server/src/fhir/accesspolicy.ts
 * (`buildAccessPolicy`, `addDefaultResourceTypes`, `applyProjectAdminAccessPolicy`).
 */
import {
  badRequest,
  OperationOutcomeError,
  parseReference,
  projectAdminResourceTypes,
  resolveId,
} from "@medplum/core"
import type {
  AccessPolicy,
  AccessPolicyResource,
  Project,
  ProjectMembership,
  ProjectMembershipAccess,
  Reference,
} from "@medplum/fhirtypes"
import type { MockRepository } from "../fhir/repo.js"

export type PopulatedAccessPolicy = AccessPolicy & { resource: AccessPolicyResource[] }

const readPolicy = (system: MockRepository, reference: Reference<AccessPolicy>): AccessPolicy => {
  try {
    const [type, id] = parseReference(reference)
    return system.readResourceImpl<AccessPolicy>(type, id)
  } catch {
    throw new OperationOutcomeError(
      badRequest(
        "Cannot authenticate: Invalid access policy configuration. Please contact your administrator to update your project membership.",
      ),
    )
  }
}

const substitute = (
  policy: AccessPolicy,
  access: ProjectMembershipAccess,
  profile: Reference | undefined,
): AccessPolicy => {
  const params = [...(access.parameter ?? [])]
  params.push({ name: "profile", valueReference: profile })
  if (!params.some((p) => p.name === "patient"))
    params.push({ name: "patient", valueReference: profile })
  let json = JSON.stringify(policy)
  for (const param of params) {
    if (param.valueString) {
      json = json.replaceAll(`%${param.name}`, param.valueString)
    } else if (param.valueReference) {
      json = json.replaceAll(`%${param.name}.id`, resolveId(param.valueReference) as string)
      json = json.replaceAll(`%${param.name}`, param.valueReference.reference as string)
    }
  }
  return JSON.parse(json) as AccessPolicy
}

export const buildAccessPolicy = (
  system: MockRepository,
  membership: ProjectMembership,
): PopulatedAccessPolicy => {
  const access: ProjectMembershipAccess[] = []
  if (membership.accessPolicy) access.push({ policy: membership.accessPolicy })
  if (membership.access) access.push(...membership.access)
  let compartment: Reference | undefined
  const resourcePolicies: AccessPolicyResource[] = []
  for (const entry of access) {
    if (!entry.policy?.reference) throw new Error("Access policy reference is required")
    const replaced = substitute(readPolicy(system, entry.policy), entry, membership.profile)
    if (replaced.compartment) compartment = replaced.compartment
    for (const policy of replaced.resource ?? []) {
      if (!policy.interaction && policy.readonly)
        policy.interaction = ["search", "read", "history", "vread"]
      resourcePolicies.push(policy)
    }
  }
  if (!membership.access?.length && !membership.accessPolicy)
    resourcePolicies.push({ resourceType: "*" })
  for (const resourceType of ["SearchParameter", "StructureDefinition"]) {
    if (!resourcePolicies.some((r) => r.resourceType === resourceType)) {
      resourcePolicies.push({ resourceType, readonly: true })
    }
  }
  return {
    resourceType: "AccessPolicy",
    basedOn: access.map((a) => a.policy),
    compartment,
    resource: resourcePolicies,
  } as PopulatedAccessPolicy
}

export const applyProjectAdminAccessPolicy = (
  project: Project,
  membership: ProjectMembership,
  accessPolicy: PopulatedAccessPolicy,
): PopulatedAccessPolicy => {
  if (project.superAdmin) {
    for (const type of projectAdminResourceTypes) {
      if (!accessPolicy.resource.some((r) => r.resourceType === type))
        accessPolicy.resource.push({ resourceType: type })
    }
  } else if (membership.admin) {
    const projectId = resolveId(membership.project)
    accessPolicy.resource = accessPolicy.resource.filter(
      (r) => !projectAdminResourceTypes.includes(r.resourceType),
    )
    accessPolicy.resource.push(
      {
        resourceType: "Project",
        criteria: `Project?_id=${projectId}`,
        readonlyFields: ["features", "link", "systemSetting"],
        hiddenFields: ["superAdmin", "systemSecret", "strictMode"],
        interaction: ["read", "vread", "update", "history", "create", "search"],
      },
      {
        resourceType: "Project",
        hiddenFields: [
          "superAdmin",
          "setting",
          "systemSetting",
          "secret",
          "systemSecret",
          "strictMode",
        ],
        interaction: ["read", "vread", "history", "search"],
      },
      {
        resourceType: "ProjectMembership",
        criteria: `ProjectMembership?_project=${projectId}`,
        readonlyFields: ["project", "user"],
      },
      {
        resourceType: "UserSecurityRequest",
        criteria: `UserSecurityRequest?_project=${projectId}`,
        readonly: true,
      },
      {
        resourceType: "User",
        criteria: `User?_project=${projectId}`,
        hiddenFields: ["passwordHash", "mfaSecret"],
        readonlyFields: ["email", "emailVerified", "mfaEnrolled", "project"],
      },
      { resourceType: "Package", readonly: true },
      { resourceType: "PackageRelease", readonly: true },
      { resourceType: "PackageInstallation", readonly: true },
    )
  } else {
    accessPolicy.resource = accessPolicy.resource.filter(
      (r) => !projectAdminResourceTypes.includes(r.resourceType),
    )
  }
  return accessPolicy
}

/** `getAccessPolicyForLogin`, without SMART scope narrowing. */
export const getAccessPolicyForMembership = (
  system: MockRepository,
  project: Project,
  membership: ProjectMembership,
): PopulatedAccessPolicy =>
  applyProjectAdminAccessPolicy(project, membership, buildAccessPolicy(system, membership))
