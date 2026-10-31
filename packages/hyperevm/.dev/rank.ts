/**
 * Refresh `registry/nodes.json` and `registry/history.json`.
 *
 * Refuses to write when a source list fails to download, or when a previously
 * healthy registry would be replaced by a run where every probe missed chain
 * id 999 or by a ranking with no eligible endpoint. That keeps one bad network
 * day from emptying the default pool.
 * The table marks endpoints whose latest HyperCore read precompile probe
 * failed (`NO-CORE`); those are listed but kept out of the default pool.
 *
 * Usage: `bun run rank` or `bun run .dev/rank.ts --dry-run`
 * @module
 */

import { readFile, writeFile } from "node:fs/promises";

import {
  defaultRankPolicy,
  mergeEndpointInputs,
  rankRegistry,
  refuseRegistryRewrite,
  type ProbeObservation,
} from "../src/registry/_policy.ts";
import { assertRegistryFile, type RegistryFile } from "../src/registry/_registry.ts";
import { assignLags, mapPool, probeEndpoint } from "./probe.ts";
import { loadSources } from "./sources.ts";

const REGISTRY_PATH = new URL("../registry/nodes.json", import.meta.url);
const HISTORY_PATH = new URL("../registry/history.json", import.meta.url);

interface HistoryFile {
  version: 1;
  observations: ProbeObservation[];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const previous = await readRegistry();
  const history = await readHistory();
  const fetched = await loadSources();
  if (fetched.length === 0) throw new Error("Source lists returned no RPC URLs.");
  const now = new Date();
  const merged = mergeEndpointInputs(fetched, previous.endpoints, now.toISOString());
  const httpEndpoints = merged.filter((endpoint) => endpoint.kind === "http");
  console.log(`Probing ${httpEndpoints.length} HTTP endpoints (${merged.length} listed).`);
  const probed = await mapPool(httpEndpoints, 3, (endpoint) => probeEndpoint(endpoint.url, { now }));
  const withLag = assignLags(probed);
  const successes = withLag.filter((observation) => observation.chainIdOk && observation.ok);
  const previousEligible = previous.endpoints.filter((endpoint) => endpoint.eligible).length;
  if (successes.length === 0 && previousEligible > 0) {
    throw new Error("No endpoint returned chain id 999. Refusing to rewrite the registry.");
  }
  const windowStart = now.getTime() - defaultRankPolicy.windowMs;
  const retained = history.observations.filter((observation) => {
    const at = Date.parse(observation.at);
    return Number.isFinite(at) && at >= windowStart;
  });
  const observations = [...retained, ...withLag];
  const ranked = rankRegistry(merged, observations, now.getTime(), previous.policy);
  // Probe vetoes such as a failed HyperCore read can empty the pool even when chain checks passed.
  const refusal = refuseRegistryRewrite(previous.endpoints, ranked);
  if (refusal) throw new Error(refusal);
  const next: RegistryFile = {
    version: 1,
    chainId: 999,
    updatedAt: now.toISOString(),
    policy: previous.policy,
    endpoints: ranked,
  };
  assertRegistryFile(next);
  printTable(next);
  if (dryRun) {
    console.log("Dry run. Registry files were not written.");
    return;
  }
  const nextHistory: HistoryFile = { version: 1, observations };
  await writeFile(REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`);
  await writeFile(HISTORY_PATH, `${JSON.stringify(nextHistory, null, 2)}\n`);
  console.log(`Wrote ${ranked.length} endpoints and ${observations.length} observations in the window.`);
}

function printTable(registry: RegistryFile): void {
  for (const endpoint of registry.endpoints) {
    const latency = endpoint.stats?.latencyMs ?? "-";
    const uptime = endpoint.stats ? `${Math.round(endpoint.stats.uptime * 100)}%` : "-";
    const rank = endpoint.rank ?? "-";
    const precompile =
      endpoint.stats?.precompileOk === true ? "core" : endpoint.stats?.precompileOk === false ? "NO-CORE" : "-";
    console.log(
      `${String(rank).padStart(3)}  w=${endpoint.weight.toFixed(3)}  ${uptime.padStart(4)}  ${String(latency).padStart(8)}ms  ${precompile.padEnd(7)}  ${endpoint.kind.padEnd(9)}  ${endpoint.url}`,
    );
  }
}

async function readRegistry(): Promise<RegistryFile> {
  const text = await readFile(REGISTRY_PATH, "utf8");
  const parsed: unknown = JSON.parse(text);
  assertRegistryFile(parsed);
  return { ...parsed, policy: { ...defaultRankPolicy, ...parsed.policy } };
}

async function readHistory(): Promise<HistoryFile> {
  try {
    const text = await readFile(HISTORY_PATH, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("observations" in parsed) ||
      !Array.isArray(parsed.observations)
    ) {
      return { version: 1, observations: [] };
    }
    return { version: 1, observations: parsed.observations as ProbeObservation[] };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, observations: [] };
    throw error;
  }
}

await main();
