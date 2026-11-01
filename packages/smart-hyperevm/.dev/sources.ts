/**
 * Pull public HyperEVM RPC lists. Parsers are pure so tests can feed fixtures.
 * Chain id 999 on ethereum-lists is Wanchain Testnet, so that file is not a source.
 * @module
 */

import type { RegistryEndpointInput, RegistrySource, Tracking } from "../src/registry/_policy.ts";
import { isWanchainHost, normalizeRpcUrl } from "../src/registry/_url.ts";

export const SOURCE_URLS = {
  chainlistChain:
    "https://raw.githubusercontent.com/DefiLlama/chainlist/main/constants/additionalChainRegistry/chainid-999.js",
  chainlistExtra: "https://raw.githubusercontent.com/DefiLlama/chainlist/main/constants/extraRpcs.js",
  chainindex: "https://www.chainindex.dev/chains/hyperevm",
  openChainBench: "https://openchainbench.com/benchmarks/hyperliquid-rpc",
  hyperliquidDocs: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
} as const;

const PAGE_DENY_HOSTS = [
  "openchainbench.com",
  "chainindex.dev",
  "gitbook.io",
  "github.com",
  "githubusercontent.com",
  "linkedin.com",
  "wikidata.org",
  "doi.org",
  "creativecommons.org",
  "huggingface.co",
  "schema.org",
  "w3.org",
  "npmjs.com",
  "x.com",
  "twitter.com",
];

const URL_PATTERN = /(?:https?|wss?):\/\/[^\s"'`<>\\),]+/g;

/** Fetch one source document. Throws on a non-2xx response so a partial pull cannot drop endpoints. */
export async function fetchText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "*/*",
      "user-agent": "@bloxwap/smart-hyperevm rank-registry",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

/** Slice the `999: { ... }` object out of chainlist's extraRpcs.js. */
export function extractObjectBlock(source: string, key: string): string | undefined {
  const needle = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*\\{`);
  const match = needle.exec(source);
  if (!match) return undefined;
  const start = source.indexOf("{", match.index);
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

/** Chainlist's additional registry file for HyperEVM. Returns nothing if the file is not chain 999. */
export function parseChainlistChainFile(source: string, sourceUrl: string): RegistryEndpointInput[] {
  if (!source.includes("HyperEVM")) return [];
  if (!/"chainId"\s*:\s*999\b/.test(source)) return [];
  const rpc = source.match(/"rpc"\s*:\s*\[([\s\S]*?)\]/);
  if (!rpc?.[1]) return [];
  return endpointsFromText(rpc[1], { name: "chainlist", url: sourceUrl });
}

/** The `999` entry of chainlist extraRpcs.js, which is Hyperliquid in chainIds.js. */
export function parseChainlistExtraRpcs(source: string, sourceUrl: string): RegistryEndpointInput[] {
  const block = extractObjectBlock(source, "999");
  if (!block) return [];
  return endpointsFromText(block, { name: "chainlist-extra", url: sourceUrl }, true);
}

/**
 * HTML or markdown pages. Keeps URLs that look like RPC endpoints and drops the
 * page's own links. `testnet` hosts are chain 998 and are ignored.
 */
export function parseRpcPage(source: string, sourceName: string, sourceUrl: string): RegistryEndpointInput[] {
  return endpointsFromText(source, { name: sourceName, url: sourceUrl }, false, true);
}

/** Download every source and merge by URL. */
export async function loadSources(fetchImpl: typeof fetch = fetch): Promise<RegistryEndpointInput[]> {
  const [chainFile, extraFile, chainindex, bench, docs] = await Promise.all([
    fetchText(SOURCE_URLS.chainlistChain, fetchImpl),
    fetchText(SOURCE_URLS.chainlistExtra, fetchImpl),
    fetchText(SOURCE_URLS.chainindex, fetchImpl),
    fetchText(SOURCE_URLS.openChainBench, fetchImpl),
    fetchText(SOURCE_URLS.hyperliquidDocs, fetchImpl),
  ]);
  const groups = [
    parseChainlistChainFile(chainFile, SOURCE_URLS.chainlistChain),
    parseChainlistExtraRpcs(extraFile, SOURCE_URLS.chainlistExtra),
    parseRpcPage(chainindex, "chainindex", SOURCE_URLS.chainindex),
    parseRpcPage(bench, "openchainbench", SOURCE_URLS.openChainBench),
    parseRpcPage(docs, "hyperliquid-docs", SOURCE_URLS.hyperliquidDocs),
  ];
  return dedupe(groups.flat());
}

function dedupe(endpoints: readonly RegistryEndpointInput[]): RegistryEndpointInput[] {
  const byUrl = new Map<string, RegistryEndpointInput>();
  for (const endpoint of endpoints) {
    const existing = byUrl.get(endpoint.url);
    if (!existing) {
      byUrl.set(endpoint.url, endpoint);
      continue;
    }
    const sources = [...existing.sources];
    for (const source of endpoint.sources) {
      if (!sources.some((item) => item.name === source.name && item.url === source.url)) sources.push(source);
    }
    byUrl.set(endpoint.url, { ...existing, sources, tracking: stricter(existing.tracking, endpoint.tracking) });
  }
  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}

function stricter(
  left: RegistryEndpointInput["tracking"],
  right: RegistryEndpointInput["tracking"],
): RegistryEndpointInput["tracking"] {
  const rank = { unknown: 0, none: 1, limited: 2, yes: 3 };
  return rank[left] >= rank[right] ? left : right;
}

function endpointsFromText(
  source: string,
  attribution: RegistrySource,
  withTracking = false,
  rpcLikeOnly = false,
): RegistryEndpointInput[] {
  const found: RegistryEndpointInput[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(URL_PATTERN)) {
    const raw = match[0];
    if (!raw) continue;
    const normalized = acceptUrl(raw, rpcLikeOnly);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    found.push({
      url: normalized.url,
      kind: normalized.kind,
      tracking: withTracking ? trackingAfter(source, match.index ?? 0) : "unknown",
      sources: [{ ...attribution }],
      submission: "upstream",
      addedAt: "",
    });
  }
  return found;
}

function acceptUrl(raw: string, rpcLikeOnly: boolean): { url: string; kind: "http" | "websocket" } | undefined {
  const trimmed = raw.replace(/[),.;\\]+$/, "");
  let normalized: ReturnType<typeof normalizeRpcUrl>;
  try {
    normalized = normalizeRpcUrl(trimmed);
  } catch {
    return undefined;
  }
  if (normalized.kind === "http" && !normalized.url.startsWith("https:")) return undefined;
  if (normalized.kind === "websocket" && !normalized.url.startsWith("wss:")) return undefined;
  if (normalized.url.toLowerCase().includes("testnet")) return undefined;
  if (isWanchainHost(normalized.url)) return undefined;
  if (rpcLikeOnly && !isRpcLike(normalized.url)) return undefined;
  return normalized;
}

function isRpcLike(url: string): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (PAGE_DENY_HOSTS.some((denied) => host === denied || host.endsWith(`.${denied}`))) return false;
  return (
    host.includes("rpc") ||
    host.includes("drpc") ||
    parsed.pathname.includes("/evm") ||
    parsed.pathname.includes("/rpc")
  );
}

function trackingAfter(source: string, index: number): Tracking {
  const slice = source.slice(index, index + 280);
  const match = slice.match(/tracking\s*:\s*["'](none|limited|yes|unknown)["']/);
  if (match?.[1] === "none" || match?.[1] === "limited" || match?.[1] === "yes" || match?.[1] === "unknown") {
    return match[1];
  }
  return "unknown";
}
