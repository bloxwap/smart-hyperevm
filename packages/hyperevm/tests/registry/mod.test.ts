import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import { assertRegistryFile, defaultRegistry, registryHttpEndpoints } from "../../src/registry/mod.ts";
import { normalizeRpcUrl } from "../../src/registry/_url.ts";

describe("shipped registry", () => {
  test("matches the schema invariants and the HTTP pool", () => {
    const text = readFileSync(new URL("../../registry/nodes.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(text);
    assertRegistryFile(parsed);
    expect(defaultRegistry.chainId).toBe(999);
    expect(defaultRegistry.version).toBe(1);
    expect(defaultRegistry.endpoints.length).toBeGreaterThan(0);

    const urls = new Set<string>();
    const ranks: number[] = [];
    for (const endpoint of defaultRegistry.endpoints) {
      expect(urls.has(endpoint.url)).toBe(false);
      urls.add(endpoint.url);
      expect(endpoint.url).not.toContain("wandevs.org");
      expect(endpoint.url).not.toContain("testnet");
      expect(endpoint.sources.length).toBeGreaterThan(0);
      const normalized = normalizeRpcUrl(endpoint.url);
      expect(normalized.url).toBe(endpoint.url);
      expect(normalized.kind).toBe(endpoint.kind);
      if (endpoint.kind === "http") expect(endpoint.url.startsWith("https:")).toBe(true);
      if (endpoint.eligible) {
        expect(endpoint.weight).toBeGreaterThan(0);
        expect(endpoint.rank).toBeGreaterThan(0);
        if (endpoint.rank !== null) ranks.push(endpoint.rank);
      } else {
        expect(endpoint.weight).toBe(0);
        expect(endpoint.rank).toBeNull();
      }
    }
    expect(ranks.sort((a, b) => a - b)).toEqual(ranks.map((_, index) => index + 1));
    expect(registryHttpEndpoints().map((endpoint) => endpoint.url)).toEqual(
      defaultRegistry.endpoints
        .filter((endpoint) => endpoint.kind === "http" && endpoint.eligible)
        .map((endpoint) => endpoint.url),
    );
  });
});

describe("assertRegistryFile", () => {
  test("rejects a wandevs.org hostname and accepts a lookalike", () => {
    expect(() => assertRegistryFile(registryFile("https://gwan-ssl.wandevs.org:46891/"))).toThrow(/Wanchain/);
    expect(() => assertRegistryFile(registryFile("https://wandevs.org/evm"))).toThrow(/Wanchain/);
    expect(() => assertRegistryFile(registryFile("wss://rpc.wandevs.org/"))).toThrow(/Wanchain/);
    expect(() => assertRegistryFile(registryFile("https://notwandevs.org/evm"))).not.toThrow();
    expect(() => assertRegistryFile(registryFile("https://wandevs.org.evil.example/evm"))).not.toThrow();
    expect(() => assertRegistryFile(registryFile("https://rpc.example/wandevs.org"))).not.toThrow();
  });

  test("accepts precompileOk as a boolean, null, or absent, and rejects anything else", () => {
    const withStats = (precompileOk: unknown): unknown => {
      const file = registryFile("https://rpc.example/evm") as { endpoints: Record<string, unknown>[] };
      const stats: Record<string, unknown> = {
        observations: 1,
        successes: 1,
        uptime: 1,
        latencyMs: 100,
        tailMs: 100,
        medianLag: 0,
        established: false,
      };
      if (precompileOk !== undefined) stats.precompileOk = precompileOk;
      for (const endpoint of file.endpoints) endpoint.stats = stats;
      return file;
    };
    for (const ok of [true, false, null, undefined]) expect(() => assertRegistryFile(withStats(ok))).not.toThrow();
    expect(() => assertRegistryFile(withStats("yes"))).toThrow(/precompileOk/);
  });
});

function registryFile(url: string): unknown {
  return {
    version: 1,
    chainId: 999,
    updatedAt: "2026-10-30T00:00:00.000Z",
    policy: {
      windowMs: 1,
      minObservations: 1,
      minSpanMs: 1,
      minUptime: 0.8,
      minEligibleUptime: 0.5,
      newNodeWeightCap: 0.15,
      maxNewNodeShare: 0.25,
    },
    endpoints: [
      {
        url,
        kind: url.startsWith("wss:") ? "websocket" : "http",
        tracking: "unknown",
        sources: [{ name: "chainlist", url: "https://example.test/chain" }],
        submission: "upstream",
        addedAt: "2026-10-30T00:00:00.000Z",
        eligible: false,
        weight: 0,
        rank: null,
        stats: null,
      },
    ],
  };
}
