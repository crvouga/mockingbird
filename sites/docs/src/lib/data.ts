import type { AstroGlobal } from "astro";

export interface ServiceMetadata {
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
  status: "implemented" | "experimental" | "wip";
  surfaces: string[];
  example?: {
    code: string;
    description: string;
  };
}

export interface Catalog {
  generated: string;
  version: string;
  rationale: string;
  services: ServiceMetadata[];
}

export interface CompatibilityMatrix {
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

let catalog: Catalog | null = null;
let compatibility: CompatibilityMatrix | null = null;

async function loadCatalog(): Promise<Catalog> {
  try {
    const data = await import("../data/catalog.json");
    return data.default;
  } catch {
    return {
      generated: new Date().toISOString(),
      version: "1.0.0",
      rationale: "Mockingbird provides stateful test doubles for APIs.",
      services: [],
    };
  }
}

async function loadCompatibility(): Promise<CompatibilityMatrix> {
  try {
    const data = await import("../data/compatibility.json");
    return data.default;
  } catch {
    return {
      generated: new Date().toISOString(),
      features: {},
    };
  }
}

export async function getCatalog(): Promise<Catalog> {
  if (catalog) return catalog;
  catalog = await loadCatalog();
  return catalog;
}

export async function getCompatibility(): Promise<CompatibilityMatrix> {
  if (compatibility) return compatibility;
  compatibility = await loadCompatibility();
  return compatibility;
}

export async function getService(
  name: string,
  catalog_?: Catalog
): Promise<ServiceMetadata | null> {
  const cat = catalog_ || (await getCatalog());
  return cat.services.find((s) => s.name === name) || null;
}

export async function getAllServices(catalog_?: Catalog): Promise<ServiceMetadata[]> {
  const cat = catalog_ || (await getCatalog());
  return cat.services;
}
