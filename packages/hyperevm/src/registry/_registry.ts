/**
 * The committed public registry. Weights are produced by `bun run rank`.
 * @module
 */

import raw from "../../registry/nodes.json" with { type: "json" };

import {
  type RankPolicy,
  type RegistryEndpoint,
  type RegistrySource,
  type Submission,
  type Tracking,
  defaultRankPolicy,
} from "./_policy.ts";
import { isWanchainHost } from "./_url.ts";

/** On-disk registry document. Version 1 is the only shape this package reads. */
export interface RegistryFile {
  version: 1;
  chainId: 999;
  updatedAt: string;
  policy: RankPolicy;
  endpoints: RegistryEndpoint[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Registry ${label} must be a non-empty string.`);
  }
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Registry ${label} must be a finite number.`);
  }
  return value;
}

function expectSource(value: unknown, label: string): RegistrySource {
  if (!isRecord(value)) throw new Error(`Registry ${label} must be an object.`);
  return {
    name: expectString(value.name, `${label}.name`),
    url: expectString(value.url, `${label}.url`),
  };
}

function expectTracking(value: unknown, label: string): Tracking {
  if (value === "none" || value === "limited" || value === "yes" || value === "unknown") return value;
  throw new Error(`Registry ${label} has an unknown tracking value.`);
}

function expectSubmission(value: unknown, label: string): Submission {
  if (value === "upstream" || value === "community") return value;
  throw new Error(`Registry ${label} has an unknown submission value.`);
}

function expectPolicy(value: unknown): RankPolicy {
  if (!isRecord(value)) throw new Error("Registry policy must be an object.");
  return {
    windowMs: expectNumber(value.windowMs, "policy.windowMs"),
    minObservations: expectNumber(value.minObservations, "policy.minObservations"),
    minSpanMs: expectNumber(value.minSpanMs, "policy.minSpanMs"),
    minUptime: expectNumber(value.minUptime, "policy.minUptime"),
    minEligibleUptime: expectNumber(value.minEligibleUptime, "policy.minEligibleUptime"),
    newNodeWeightCap: expectNumber(value.newNodeWeightCap, "policy.newNodeWeightCap"),
    maxNewNodeShare: expectNumber(value.maxNewNodeShare, "policy.maxNewNodeShare"),
  };
}

function expectEndpoint(value: unknown, index: number): RegistryEndpoint {
  if (!isRecord(value)) throw new Error(`Registry endpoints[${index}] must be an object.`);
  const label = `endpoints[${index}]`;
  const kind = value.kind;
  if (kind !== "http" && kind !== "websocket") {
    throw new Error(`Registry ${label}.kind must be "http" or "websocket".`);
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error(`Registry ${label}.sources must list at least one source.`);
  }
  const rank = value.rank;
  if (rank !== null && (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1)) {
    throw new Error(`Registry ${label}.rank must be a positive integer or null.`);
  }
  return {
    url: expectString(value.url, `${label}.url`),
    kind,
    tracking: expectTracking(value.tracking, `${label}.tracking`),
    sources: value.sources.map((source, sourceIndex) => expectSource(source, `${label}.sources[${sourceIndex}]`)),
    submission: expectSubmission(value.submission, `${label}.submission`),
    addedAt: expectString(value.addedAt, `${label}.addedAt`),
    eligible: value.eligible === true,
    weight: expectNumber(value.weight, `${label}.weight`),
    rank,
    stats: value.stats === null ? null : expectStats(value.stats, label),
  };
}

function expectStats(value: unknown, label: string): RegistryEndpoint["stats"] {
  if (!isRecord(value)) throw new Error(`Registry ${label}.stats must be an object or null.`);
  const latency = value.latencyMs;
  const tail = value.tailMs;
  const lag = value.medianLag;
  if (latency !== null && typeof latency !== "number") throw new Error(`Registry ${label}.stats.latencyMs is invalid.`);
  if (tail !== null && typeof tail !== "number") throw new Error(`Registry ${label}.stats.tailMs is invalid.`);
  if (lag !== null && typeof lag !== "number") throw new Error(`Registry ${label}.stats.medianLag is invalid.`);
  const precompile = value.precompileOk;
  if (precompile !== undefined && precompile !== null && typeof precompile !== "boolean") {
    throw new Error(`Registry ${label}.stats.precompileOk is invalid.`);
  }
  return {
    observations: expectNumber(value.observations, `${label}.stats.observations`),
    successes: expectNumber(value.successes, `${label}.stats.successes`),
    uptime: expectNumber(value.uptime, `${label}.stats.uptime`),
    latencyMs: latency === null ? null : latency,
    tailMs: tail === null ? null : tail,
    medianLag: lag === null ? null : lag,
    established: value.established === true,
    ...(precompile === undefined ? {} : { precompileOk: precompile }),
  };
}

/** Throw when `value` is not a version-1 HyperEVM registry. */
export function assertRegistryFile(value: unknown): asserts value is RegistryFile {
  if (!isRecord(value)) throw new Error("Registry must be an object.");
  if (value.version !== 1) throw new Error("Registry version must be 1.");
  if (value.chainId !== 999) throw new Error("Registry chainId must be 999.");
  expectString(value.updatedAt, "updatedAt");
  const policy = expectPolicy(value.policy);
  if (!Array.isArray(value.endpoints)) throw new Error("Registry endpoints must be an array.");
  const endpoints = value.endpoints.map((endpoint, index) => expectEndpoint(endpoint, index));
  const urls = new Set<string>();
  for (const endpoint of endpoints) {
    if (urls.has(endpoint.url)) throw new Error(`Registry lists ${endpoint.url} more than once.`);
    urls.add(endpoint.url);
    if (isWanchainHost(endpoint.url)) {
      throw new Error("Registry must not include the Wanchain endpoint that shares chain id 999.");
    }
  }
  void policy;
}

/** The registry shipped with this package. */
export const defaultRegistry: RegistryFile = parseRegistry(raw);

function parseRegistry(value: unknown): RegistryFile {
  assertRegistryFile(value);
  return value;
}

/** HTTP endpoints the default transport will actually call. */
export function registryHttpEndpoints(): { url: string; weight: number }[] {
  return defaultRegistry.endpoints
    .filter((endpoint) => endpoint.kind === "http" && endpoint.eligible && endpoint.weight > 0)
    .map((endpoint) => ({ url: endpoint.url, weight: endpoint.weight }));
}

/** Policy shipped in the registry file, falling back to the code default if a field were ever absent. */
export function registryPolicy(): RankPolicy {
  return { ...defaultRankPolicy, ...defaultRegistry.policy };
}
