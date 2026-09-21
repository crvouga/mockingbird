#!/usr/bin/env bun

/**
 * Generates agent-friendly documentation from service metadata.
 * Outputs:
 * - sites/docs/src/data/catalog.json (service metadata, APIs, examples)
 * - sites/docs/src/data/compatibility.json (compatibility matrix)
 *
 * Prevents doc drift by deriving everything from code.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

interface ServiceMetadata {
  name: string;
  packageName: string;
  description: string;
  provider: string;
  runtime: "portable" | "node" | "bun";
  keywords: string[];
  npmUrl: string;
  repoUrl: string;
  readmeUrl: string;
  supportUrl?: string;
  entries: Record<string, "node" | "bun" | "portable">;
  status: "implemented" | "experimental" | "deprecated";
  surfaces: string[];
}

interface Catalog {
  generated: string;
  version: string;
  rationale: string;
  services: ServiceMetadata[];
}

// Resolve to the repo root regardless of where the script is called from
const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptFile);
const REPO_ROOT = dirname(scriptDir);
const SERVICES_DIR = join(REPO_ROOT, "packages/service");
const DOCS_DATA_DIR = join(REPO_ROOT, "sites/docs/src/data");

// Ensure output dir exists
mkdirSync(DOCS_DATA_DIR, { recursive: true });

const rationale = `
Mockingbird provides stateful test doubles for 40+ third-party HTTP APIs and SQL databases.
Each mock speaks the provider's real surface (fetch(Request) → Response), keeps state in SQLite,
and is driven by a vendored OpenAPI contract. Use them in tests instead of hitting the network,
or serve them over Node/Bun when you need a local origin.

Why this matters: No more mocking libraries with divergent behavior. No more flaky tests that pass
against mocks but fail against real APIs. Mockingbird keeps behavior in sync with the real vendor
through continuous property-based testing (PBT) against live sandboxes.

All mocks are isomorphic and runnable client-side (in browser, Workers, etc.) with Hono.
`.trim();

function getServiceMetadata(serviceDir: string): ServiceMetadata | null {
  try {
    const pkgPath = join(serviceDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    if (!pkg.mockingbird || pkg.mockingbird.layer !== "service" || pkg.private === true) {
      return null;
    }

    const serviceName = pkg.name.replace(/@crvouga\/mockingbird-service-/, "");
    const readmePath = join(serviceDir, "README.md");
    const supportPath = join(serviceDir, "SUPPORT.md");

    return {
      name: serviceName,
      packageName: pkg.name,
      description: pkg.description || "",
      provider: pkg.keywords?.[2] || serviceName,
      runtime: pkg.mockingbird.runtime || "portable",
      keywords: pkg.keywords || [],
      npmUrl: `https://www.npmjs.com/package/${pkg.name}`,
      repoUrl: `https://github.com/crvouga/mockingbird/tree/main/packages/service/${serviceName}`,
      readmeUrl: `https://github.com/crvouga/mockingbird/blob/main/packages/service/${serviceName}/README.md`,
      supportUrl: supportPath
        ? `https://github.com/crvouga/mockingbird/blob/main/packages/service/${serviceName}/SUPPORT.md`
        : undefined,
      entries: pkg.mockingbird.entries || { default: "portable" },
      status: "implemented",
      surfaces: extractSurfaces(serviceName, readmePath),
    };
  } catch {
    return null;
  }
}

function extractSurfaces(serviceName: string, readmePath: string): string[] {
  try {
    const readme = readFileSync(readmePath, "utf-8");

    // Extract surfaces from README (Fetch API, Server, CLI, GraphQL, etc.)
    const surfaces: string[] = [];

    if (
      readme.includes("fetch(") ||
      readme.includes("createFetch") ||
      serviceName.includes("service-")
    ) {
      surfaces.push("Fetch API");
    }
    if (
      readme.includes("createServer") ||
      readme.includes("Server") ||
      serviceName.includes("server")
    ) {
      surfaces.push("Node Server");
    }
    if (readme.includes("CLI") || readme.includes("npx")) {
      surfaces.push("CLI");
    }
    if (
      readme.includes("GraphQL") ||
      serviceName.includes("graphql") ||
      serviceName.includes("healthie")
    ) {
      surfaces.push("GraphQL");
    }
    if (readme.includes("WebSocket") || serviceName.includes("daily")) {
      surfaces.push("WebSocket");
    }
    if (readme.includes("h2c") || readme.includes("stream")) {
      surfaces.push("HTTP/2");
    }

    return surfaces.length > 0 ? surfaces : ["Fetch API"];
  } catch {
    return ["Fetch API"];
  }
}

function generateCatalog(): Catalog {
  const serviceNames = readdirSync(SERVICES_DIR);
  const services: ServiceMetadata[] = [];

  for (const serviceName of serviceNames) {
    const serviceDir = join(SERVICES_DIR, serviceName);
    const metadata = getServiceMetadata(serviceDir);
    if (metadata) {
      services.push(metadata);
    }
  }

  // Sort by name for consistency
  services.sort((a, b) => a.name.localeCompare(b.name));

  return {
    generated: new Date().toISOString(),
    version: "1.0.0",
    rationale,
    services,
  };
}

interface CompatibilityMatrix {
  generated: string;
  features: {
    [service: string]: {
      ["Fetch API"]: boolean;
      ["Node Server"]: boolean;
      CLI: boolean;
      GraphQL: boolean;
      WebSocket: boolean;
      ["HTTP/2"]: boolean;
    };
  };
}

function generateCompatibilityMatrix(catalog: Catalog): CompatibilityMatrix {
  const matrix: CompatibilityMatrix = {
    generated: new Date().toISOString(),
    features: {},
  };

  for (const service of catalog.services) {
    matrix.features[service.name] = {
      "Fetch API": service.surfaces.includes("Fetch API"),
      "Node Server": service.surfaces.includes("Node Server"),
      CLI: service.surfaces.includes("CLI"),
      GraphQL: service.surfaces.includes("GraphQL"),
      WebSocket: service.surfaces.includes("WebSocket"),
      "HTTP/2": service.surfaces.includes("HTTP/2"),
    };
  }

  return matrix;
}

// Generate and write catalog
const catalog = generateCatalog();
writeFileSync(
  join(DOCS_DATA_DIR, "catalog.json"),
  JSON.stringify(catalog, null, 2)
);

// Generate and write compatibility matrix
const compatibility = generateCompatibilityMatrix(catalog);
writeFileSync(
  join(DOCS_DATA_DIR, "compatibility.json"),
  JSON.stringify(compatibility, null, 2)
);

console.log(`✓ Generated catalog with ${catalog.services.length} services`);
console.log(`✓ Wrote to ${join(DOCS_DATA_DIR, "catalog.json")}`);
console.log(`✓ Wrote compatibility matrix to ${join(DOCS_DATA_DIR, "compatibility.json")}`);
