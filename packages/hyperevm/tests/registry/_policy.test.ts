import { describe, expect, test } from "bun:test";

import {
  defaultRankPolicy,
  LOGS_RANGE_PROBE,
  mergeEndpointInputs,
  PRECOMPILE_PROBE,
  rankRegistry,
  refuseRegistryRewrite,
  type ProbeObservation,
  type RegistryEndpointInput,
} from "../../src/registry/_policy.ts";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function endpoint(url: string, kind: RegistryEndpointInput["kind"] = "http"): RegistryEndpointInput {
  return {
    url,
    kind,
    tracking: "unknown",
    sources: [{ name: "chainlist", url: "https://example.test/chain" }],
    submission: "upstream",
    addedAt: new Date(NOW - 30 * DAY).toISOString(),
  };
}

function observation(url: string, daysAgo: number, ms: number, ok = true, chainIdOk = true): ProbeObservation {
  return {
    at: new Date(NOW - daysAgo * DAY).toISOString(),
    url,
    ok: ok && chainIdOk,
    chainIdOk,
    head: chainIdOk ? 1_000 : null,
    lag: 0,
    methods: {
      eth_chainId: { ms, ok: chainIdOk },
      eth_blockNumber: { ms, ok },
      eth_call: { ms: ms + 5, ok },
      eth_getLogs: { ms: ms + 50, ok },
    },
  };
}

function withProbes(
  url: string,
  daysAgo: number,
  probes: { precompile?: boolean; range?: boolean },
  ms = 40,
): ProbeObservation {
  const sample = observation(url, daysAgo, ms);
  if (probes.precompile !== undefined) sample.methods[PRECOMPILE_PROBE] = { ms, ok: probes.precompile };
  if (probes.range !== undefined) sample.methods[LOGS_RANGE_PROBE] = { ms: ms + 100, ok: probes.range };
  return sample;
}

describe("rankRegistry", () => {
  test("a single fast probe stays under the new-node cap", () => {
    const [ranked] = rankRegistry(
      [endpoint("https://new.example/evm")],
      [observation("https://new.example/evm", 0, 40)],
      NOW,
    );
    expect(ranked?.eligible).toBe(true);
    expect(ranked?.stats?.established).toBe(false);
    expect(ranked?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
    expect(ranked?.rank).toBe(1);
  });

  test("three successes spread across the window earn full weight", () => {
    const url = "https://veteran.example/evm";
    const observations = [20, 10, 1].map((daysAgo) => observation(url, daysAgo, 80));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.established).toBe(true);
    expect(ranked?.weight).toBe(1);
  });

  test("three probes on the same day do not establish an endpoint", () => {
    const url = "https://burst.example/evm";
    const observations = [0, 0, 0].map(() => observation(url, 0, 30));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.established).toBe(false);
    expect(ranked?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
  });

  test("low uptime is listed but not eligible", () => {
    const url = "https://flaky.example/evm";
    const observations = [
      observation(url, 0, 40, true),
      observation(url, 0, 40, false),
      observation(url, 0, 40, false),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
    expect(ranked?.rank).toBeNull();
  });

  test("a wrong chain id does not count as success", () => {
    const url = "https://wanchain.example/evm";
    const [ranked] = rankRegistry([endpoint(url)], [observation(url, 0, 10, true, false)], NOW);
    expect(ranked?.eligible).toBe(false);
  });

  test("the slowest successful method sets the latency, so a cheap eth_chainId cannot hide a slow eth_getLogs", () => {
    const url = "https://skewed.example/evm";
    const sample = observation(url, 0, 20);
    sample.methods.eth_chainId = { ms: 15, ok: true };
    sample.methods.eth_getLogs = { ms: 900, ok: true };
    const [ranked] = rankRegistry([endpoint(url)], [sample], NOW);
    expect(ranked?.stats?.latencyMs).toBe(900);
  });

  test("two blocks of lag do not outrank a faster node, and a large lag does", () => {
    const fresh = "https://fresh.example/evm";
    const fast = "https://fast.example/evm";
    const behind = "https://behind.example/evm";
    const freshObs = observation(fresh, 0, 200);
    const fastObs = observation(fast, 0, 40);
    fastObs.lag = 2;
    const ranked = rankRegistry([endpoint(fresh), endpoint(fast)], [freshObs, fastObs], NOW);
    expect(ranked[0]?.url).toBe(fast);

    const behindObs = observation(behind, 0, 40);
    behindObs.lag = 10;
    const compared = rankRegistry([endpoint(fresh), endpoint(behind)], [freshObs, behindObs], NOW);
    expect(compared[0]?.url).toBe(fresh);
  });

  test("new endpoints together cannot crowd out an established one", () => {
    const veteran = "https://veteran.example/evm";
    const fresh = Array.from({ length: 10 }, (_, index) => `https://new-${index}.example/evm`);
    const observations = [
      ...[20, 10, 1].map((daysAgo) => observation(veteran, daysAgo, 100)),
      ...fresh.map((url) => observation(url, 0, 10)),
    ];
    const ranked = rankRegistry([endpoint(veteran), ...fresh.map((url) => endpoint(url))], observations, NOW);
    const established = ranked.find((item) => item.url === veteran);
    const newcomers = ranked.filter((item) => item.url !== veteran && item.eligible);
    expect(established?.weight).toBe(1);
    const newWeight = newcomers.reduce((sum, item) => sum + item.weight, 0);
    const share = newWeight / (established!.weight + newWeight);
    expect(share).toBeLessThanOrEqual(defaultRankPolicy.maxNewNodeShare + 0.001);
    expect(newcomers.every((item) => item.weight < defaultRankPolicy.newNodeWeightCap)).toBe(true);
  });

  test("websocket urls stay listed and out of the HTTP pool", () => {
    const [ranked] = rankRegistry(
      [endpoint("wss://socket.example/evm", "websocket")],
      [observation("wss://socket.example/evm", 0, 20)],
      NOW,
    );
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
    expect(ranked?.stats).toBeNull();
  });

  test("observations outside the window are ignored", () => {
    const url = "https://old.example/evm";
    const [ranked] = rankRegistry([endpoint(url)], [observation(url, 40, 20)], NOW);
    expect(ranked?.stats?.observations).toBe(0);
    expect(ranked?.eligible).toBe(false);
  });
});

describe("rankRegistry HyperCore and log range probes", () => {
  test("an endpoint whose latest precompile probe failed is listed but kept out of the default pool", () => {
    const url = "https://no-core.example/evm";
    const observations = [20, 10, 1].map((daysAgo) => withProbes(url, daysAgo, { precompile: false, range: true }));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
    expect(ranked?.rank).toBeNull();
    expect(ranked?.stats?.precompileOk).toBe(false);
  });

  test("a precompile failure excludes the endpoint even when older probes passed", () => {
    const url = "https://lost-core.example/evm";
    const observations = [
      withProbes(url, 20, { precompile: true, range: true }),
      withProbes(url, 10, { precompile: true, range: true }),
      withProbes(url, 1, { precompile: false, range: true }),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
    expect(ranked?.stats?.precompileOk).toBe(false);
  });

  test("a later passing precompile probe restores eligibility after a transient miss", () => {
    const url = "https://recovered.example/evm";
    const observations = [
      withProbes(url, 20, { precompile: true, range: true }),
      withProbes(url, 10, { precompile: false, range: true }),
      withProbes(url, 1, { precompile: true, range: true }),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(true);
    expect(ranked?.stats?.precompileOk).toBe(true);
    expect(ranked?.stats?.successes).toBe(2);
  });

  test("a probe where the node was down is not a precompile verdict", () => {
    const url = "https://blip.example/evm";
    const down = withProbes(url, 1, { precompile: false, range: false });
    down.ok = false;
    const observations = [withProbes(url, 20, { precompile: true, range: true }), withProbes(url, 10, {}), down];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.precompileOk).toBe(true);
    expect(ranked?.eligible).toBe(true);
  });

  test("a failed 999-block eth_getLogs counts as a missed probe", () => {
    const url = "https://range-capped.example/evm";
    const observations = [20, 10, 1].map((daysAgo) => withProbes(url, daysAgo, { precompile: true, range: false }));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.successes).toBe(0);
    expect(ranked?.stats?.uptime).toBe(0);
    expect(ranked?.eligible).toBe(false);
  });

  test("an occasional log range miss lowers uptime and blocks full weight", () => {
    const url = "https://sometimes-capped.example/evm";
    const observations = [
      withProbes(url, 21, { precompile: true, range: true }),
      withProbes(url, 14, { precompile: true, range: false }),
      withProbes(url, 7, { precompile: true, range: true }),
      withProbes(url, 1, { precompile: true, range: false }),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.uptime).toBe(0.5);
    expect(ranked?.stats?.established).toBe(false);
    expect(ranked?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
  });

  test("a slow node that serves HyperCore reads outranks a fast one that does not", () => {
    const core = "https://core.example/evm";
    const plain = "https://plain.example/evm";
    const observations = [
      ...[20, 10, 1].map((daysAgo) => withProbes(core, daysAgo, { precompile: true, range: true }, 200)),
      ...[20, 10, 1].map((daysAgo) => withProbes(plain, daysAgo, { precompile: false, range: true }, 20)),
    ];
    const ranked = rankRegistry([endpoint(core), endpoint(plain)], observations, NOW);
    expect(ranked[0]?.url).toBe(core);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked.find((item) => item.url === plain)?.eligible).toBe(false);
  });

  test("older observations without the new probes are not punished", () => {
    const url = "https://legacy.example/evm";
    const observations = [20, 10, 1].map((daysAgo) => observation(url, daysAgo, 80));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(true);
    expect(ranked?.stats?.established).toBe(true);
    expect(ranked?.stats?.uptime).toBe(1);
    expect(ranked?.weight).toBe(1);
    expect(ranked?.stats?.precompileOk).toBeNull();
  });

  test("the committed history still ranks with its pre-probe successes intact", async () => {
    const history = (await Bun.file(new URL("../../registry/history.json", import.meta.url)).json()) as {
      observations: ProbeObservation[];
    };
    const urls = [...new Set(history.observations.map((item) => item.url))];
    const latest = Math.max(...history.observations.map((item) => Date.parse(item.at)));
    const ranked = rankRegistry(
      urls.map((url) => endpoint(url)),
      history.observations,
      latest,
    );
    for (const row of ranked) {
      const mine = history.observations.filter((item) => item.url === row.url);
      const legacy = mine.every((item) => !(PRECOMPILE_PROBE in item.methods) && !(LOGS_RANGE_PROBE in item.methods));
      if (!legacy) continue;
      expect(row.stats?.successes).toBe(mine.filter((item) => item.ok && item.chainIdOk).length);
      expect(row.stats?.precompileOk).toBeNull();
    }
    expect(ranked.some((row) => row.eligible)).toBe(true);
  });
});

describe("mergeEndpointInputs", () => {
  test("keeps community submissions and drops upstream urls that disappeared", () => {
    const previous: RegistryEndpointInput[] = [
      {
        ...endpoint("https://gone.example/evm"),
        addedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ...endpoint("https://community.example/evm"),
        submission: "community",
        sources: [{ name: "community", url: "https://example.test/pr/1" }],
        addedAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    const fetched: RegistryEndpointInput[] = [
      {
        ...endpoint("https://community.example/evm"),
        tracking: "none",
        sources: [{ name: "chainlist", url: "https://example.test/chain" }],
        addedAt: "",
      },
      {
        ...endpoint("https://fresh.example/evm"),
        addedAt: "",
      },
    ];
    const merged = mergeEndpointInputs(fetched, previous, "2026-10-30T00:00:00.000Z");
    const urls = merged.map((item) => item.url);
    expect(urls).not.toContain("https://gone.example/evm");
    expect(urls).toContain("https://community.example/evm");
    expect(urls).toContain("https://fresh.example/evm");
    const community = merged.find((item) => item.url === "https://community.example/evm");
    expect(community?.submission).toBe("community");
    expect(community?.addedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(community?.sources.map((source) => source.name).sort()).toEqual(["chainlist", "community"]);
    expect(merged.find((item) => item.url === "https://fresh.example/evm")?.addedAt).toBe("2026-10-30T00:00:00.000Z");
  });
});

describe("refuseRegistryRewrite", () => {
  test("refuses a ranking that leaves no endpoint eligible when the previous registry had some", () => {
    const urls = ["https://a.example/evm", "https://b.example/evm"];
    const healthy = rankRegistry(
      urls.map((url) => endpoint(url)),
      urls.map((url) => withProbes(url, 3, { precompile: true, range: true })),
      NOW,
    );
    expect(healthy.every((row) => row.eligible)).toBe(true);
    // Every node passes chain and head checks, but a transient blip fails each precompile probe at once.
    const blip = rankRegistry(
      urls.map((url) => endpoint(url)),
      [
        ...urls.map((url) => withProbes(url, 3, { precompile: true, range: true })),
        ...urls.map((url) => withProbes(url, 0, { precompile: false, range: true })),
      ],
      NOW,
    );
    expect(blip.some((row) => row.eligible)).toBe(false);
    expect(refuseRegistryRewrite(healthy, blip)).toMatch(/no endpoint eligible/i);
    expect(refuseRegistryRewrite(healthy, healthy)).toBeUndefined();
    expect(refuseRegistryRewrite(blip, blip)).toBeUndefined();
  });
});
