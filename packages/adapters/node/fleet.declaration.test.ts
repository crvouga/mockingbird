import { expect, test } from "bun:test"
import {
  checkDeclaration,
  DeclarationError,
  isDeclaration,
  localFleetConfig,
  parseDeclaration,
  validateFleetConfig,
} from "./src/index.js"

const declaration = {
  version: 1,
  organization: "acme",
  name: "Acme",
  projects: {
    web: {
      name: "Web app",
      fleets: {
        "acme-staging": {
          access: "key",
          requestsPerMinute: 600,
          services: {
            stripe: { durability: "strict", seed: "42", settings: { apiVersion: "2025-02-24" } },
            resend: null,
            billing: {
              target: "stripe",
              flushIntervalMs: 500,
              webhookOrigins: ["https://a.example"],
            },
            db: { target: "postgres", protocol: "postgres", port: 5432, local: true },
          },
        },
      },
    },
  },
}

test("a declaration's fleet is a local fleet configuration with the cloud's keys removed", () => {
  const config = localFleetConfig(parseDeclaration(declaration))
  expect(config).toEqual({
    schemaVersion: 1,
    services: {
      stripe: { seed: "42", settings: { apiVersion: "2025-02-24" } },
      resend: {},
      billing: { target: "stripe" },
      db: { target: "postgres", protocol: "postgres", port: 5432 },
    },
  })
  // What comes out is exactly what the local fleet's own schema accepts.
  expect(validateFleetConfig(config)).toEqual([])
})

test("with several fleets declared, the local fleet must be named", () => {
  const two = parseDeclaration({
    version: 1,
    organization: "acme",
    projects: {
      web: { fleets: { staging: { services: { stripe: {} } } } },
      api: { fleets: { preview: { services: { resend: {} } } } },
    },
  })
  expect(() => localFleetConfig(two)).toThrow(/choose one with --fleet: staging, preview/)
  expect(Object.keys(localFleetConfig(two, "preview").services)).toEqual(["resend"])
  expect(() => localFleetConfig(two, "prod")).toThrow(/declares no fleet "prod"/)
})

test("every problem is reported at once, each with the path of its key", () => {
  const issues = checkDeclaration({
    version: 2,
    organization: "Acme Inc",
    owner: "ada",
    projects: {
      web: {
        fleets: {
          Staging: { access: "public", services: { stripe: { durability: "eventual", seed: 42 } } },
          shared: { services: {} },
        },
      },
      api: { fleets: { shared: { requestsPerMinute: 0, replicas: 3 } } },
    },
  })
  expect(issues.map((issue) => issue.path)).toEqual([
    "owner",
    "version",
    "organization",
    "projects.web.fleets.Staging",
    "projects.web.fleets.Staging.access",
    "projects.web.fleets.Staging.services.stripe.durability",
    "projects.web.fleets.Staging.services.stripe.seed",
    "projects.api.fleets.shared",
    "projects.api.fleets.shared.replicas",
    "projects.api.fleets.shared.requestsPerMinute",
  ])
  expect(() => parseDeclaration({ version: 1 })).toThrow(DeclarationError)
  expect(checkDeclaration(declaration)).toEqual([])
})

test("a declaration is told apart from a single local fleet configuration", () => {
  expect(isDeclaration(declaration)).toBe(true)
  expect(isDeclaration({ services: { stripe: {} } })).toBe(false)
  expect(isDeclaration([])).toBe(false)
})
