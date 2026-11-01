import { describe, expect, test } from "bun:test";

import { assignLags, L1_BLOCK_NUMBER_PRECOMPILE, probeEndpoint } from "../../.dev/probe.ts";
import { LOGS_RANGE_PROBE, PRECOMPILE_PROBE, type ProbeObservation, rankRegistry } from "../../src/registry/_policy.ts";

interface RpcRequest {
  method: string;
  params: unknown[];
}

const HEAD = 0x2fa_f080;
const L1_WORD = `0x${(123_456_789).toString(16).padStart(64, "0")}`;

/** A fake HyperEVM node. `override` answers a request first; return undefined to fall through. */
function node(override: (request: RpcRequest) => Response | undefined = () => undefined): {
  fetchImpl: typeof fetch;
  requests: RpcRequest[];
} {
  const requests: RpcRequest[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    requests.push(request);
    const custom = override(request);
    if (custom) return custom;
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (request.method === "eth_chainId") return ok("0x3e7");
    if (request.method === "eth_blockNumber") return ok(`0x${HEAD.toString(16)}`);
    if (request.method === "eth_getLogs") return ok([]);
    if (request.method === "eth_call") {
      const [target] = request.params as [{ to: string }];
      return ok(target.to === L1_BLOCK_NUMBER_PRECOMPILE ? L1_WORD : "0x");
    }
    return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function rpcError(code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });
}

const URL_UNDER_TEST = "https://node.example/evm";
const NOW = new Date("2026-10-30T00:00:00.000Z");

describe("probeEndpoint", () => {
  test("calls the L1 block number precompile with empty calldata and records the result", async () => {
    const { fetchImpl, requests } = node();
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    const precompileCall = requests.find(
      (request) =>
        request.method === "eth_call" && (request.params[0] as { to: string }).to === L1_BLOCK_NUMBER_PRECOMPILE,
    );
    expect(L1_BLOCK_NUMBER_PRECOMPILE).toBe("0x0000000000000000000000000000000000000809");
    expect(precompileCall?.params).toEqual([{ to: L1_BLOCK_NUMBER_PRECOMPILE, data: "0x" }, "latest"]);
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(true);
    expect(observation.ok).toBe(true);
  });

  test("queries eth_getLogs over 999 blocks ending at the probed head", async () => {
    const { fetchImpl, requests } = node();
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    const ranges = requests
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => request.params[0] as { fromBlock: string; toBlock: string });
    const wide = ranges.find((range) => range.fromBlock !== range.toBlock);
    expect(wide).toBeDefined();
    expect(Number.parseInt(wide?.toBlock ?? "", 16)).toBe(HEAD);
    expect(Number.parseInt(wide?.toBlock ?? "", 16) - Number.parseInt(wide?.fromBlock ?? "", 16) + 1).toBe(999);
    expect(observation.methods[LOGS_RANGE_PROBE]?.ok).toBe(true);
  });

  test("a node without HyperCore precompiles fails the precompile probe and drops out of the pool", async () => {
    const { fetchImpl } = node((request) => {
      const target = (request.params[0] as { to?: string } | undefined)?.to;
      if (request.method === "eth_call" && target === L1_BLOCK_NUMBER_PRECOMPILE)
        return Response.json({ result: "0x" });
      return undefined;
    });
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.ok).toBe(true);
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(false);
    const [ranked] = rankRegistry(
      [
        {
          url: URL_UNDER_TEST,
          kind: "http",
          tracking: "unknown",
          sources: [{ name: "chainlist", url: "https://example.test/chain" }],
          submission: "upstream",
          addedAt: NOW.toISOString(),
        },
      ],
      [{ ...observation, lag: 0 }],
      NOW.getTime(),
    );
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
  });

  test("a zero word from the precompile is a failure", async () => {
    const { fetchImpl } = node((request) => {
      const target = (request.params[0] as { to?: string } | undefined)?.to;
      if (request.method === "eth_call" && target === L1_BLOCK_NUMBER_PRECOMPILE) {
        return Response.json({ result: `0x${"0".repeat(64)}` });
      }
      return undefined;
    });
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(false);
  });

  test("a provider range limit on the wide eth_getLogs is recorded as a failed range probe", async () => {
    const { fetchImpl } = node((request) => {
      if (request.method !== "eth_getLogs") return undefined;
      const [range] = request.params as [{ fromBlock: string; toBlock: string }];
      if (range.fromBlock === range.toBlock) return undefined;
      return rpcError(-32602, "query exceeds max block range 100");
    });
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.methods.eth_getLogs?.ok).toBe(true);
    expect(observation.methods[LOGS_RANGE_PROBE]?.ok).toBe(false);
  });

  test("a wrong chain id fails the new probes too", async () => {
    const { fetchImpl } = node((request) =>
      request.method === "eth_chainId" ? Response.json({ result: "0x3e6" }) : undefined,
    );
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.chainIdOk).toBe(false);
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(false);
    expect(observation.methods[LOGS_RANGE_PROBE]?.ok).toBe(false);
  });
});

function observation(url: string, head: number, headAt: string): ProbeObservation {
  return {
    at: headAt,
    url,
    ok: true,
    chainIdOk: true,
    head,
    lag: null,
    headAt,
    methods: { eth_blockNumber: { ms: 10, ok: true } },
  };
}

describe("assignLags", () => {
  test("projects an earlier head forward by one block per second", () => {
    const early = observation("https://early.example/evm", 1000, "2026-10-30T00:00:00.000Z");
    const late = observation("https://late.example/evm", 1004, "2026-10-30T00:00:04.000Z");
    const [first, second] = assignLags([early, late]);
    expect(first?.lag).toBe(0);
    expect(second?.lag).toBe(0);
  });

  test("keeps a real gap after the time adjustment", () => {
    const stale = observation("https://stale.example/evm", 1000, "2026-10-30T00:00:00.000Z");
    const tip = observation("https://tip.example/evm", 1010, "2026-10-30T00:00:03.000Z");
    const [first, second] = assignLags([stale, tip]);
    expect(first?.lag).toBe(7);
    expect(second?.lag).toBe(0);
  });

  test("ignores a head from the wrong chain", () => {
    const wrong: ProbeObservation = {
      ...observation("https://wrong.example/evm", 5000, "2026-10-30T00:00:05.000Z"),
      chainIdOk: false,
      ok: false,
    };
    const right = observation("https://right.example/evm", 1000, "2026-10-30T00:00:00.000Z");
    const [first, second] = assignLags([wrong, right]);
    expect(first?.lag).toBeNull();
    expect(second?.lag).toBe(0);
  });
});
