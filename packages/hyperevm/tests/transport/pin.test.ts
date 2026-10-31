import { describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { pinParams, resolvePin } from "../../src/transport/_pin.ts";
import { hyperevm, type HyperevmTransportOptions } from "../../src/transport/mod.ts";

interface Call {
  method: string;
  params: unknown;
}

interface MockEndpoint {
  transport: Transport;
  calls: Call[];
  /** Calls other than the chain check and head probes. */
  reads: () => Call[];
}

function mockEndpoint(
  name: string,
  handler: (method: string, params: unknown) => unknown | Promise<unknown>,
): MockEndpoint {
  const calls: Call[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method, params }: EIP1193Parameters) => {
        calls.push({ method, params });
        return handler(method, params);
      }) as EIP1193RequestFn,
    });
  return {
    transport,
    calls,
    reads: () => calls.filter((call) => call.method !== "eth_chainId" && call.method !== "eth_blockNumber"),
  };
}

/** An endpoint at `head.value`. Every other read answers `0x1`. */
function node(name: string, head: { value: number }, chainId = "0x3e7"): MockEndpoint {
  return mockEndpoint(name, (method) => {
    if (method === "eth_chainId") return chainId;
    if (method === "eth_blockNumber") return hex(head.value);
    return "0x1";
  });
}

function hex(block: number): string {
  return `0x${block.toString(16)}`;
}

function open(options: HyperevmTransportOptions) {
  const client = hyperevm({
    routing: "best",
    retryCount: 2,
    hedge: false,
    verifyChainId: false,
    headLag: { probeInterval: false },
    pinLatest: true,
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
  const { value } = client;
  if (!value) throw new Error("hyperevm() returned no transport value.");
  return { request: client.request, value };
}

const TX = { to: "0x000000000000000000000000000000000000dead", data: "0x" };
const ADDRESS = "0x000000000000000000000000000000000000dead";

describe("pinParams", () => {
  test("pins an explicit or implied latest and leaves every other tag alone", () => {
    expect(pinParams("eth_call", [TX, "latest"], 100)).toEqual([TX, "0x64"]);
    expect(pinParams("eth_call", [TX], 100)).toEqual([TX, "0x64"]);
    expect(pinParams("eth_call", [TX, "latest", { [ADDRESS]: {} }], 100)).toEqual([TX, "0x64", { [ADDRESS]: {} }]);
    for (const tag of ["pending", "safe", "finalized", "earliest", "0x10"]) {
      const params = [TX, tag];
      expect(pinParams("eth_call", params, 100)).toBe(params);
    }
    const byHash = [TX, { blockHash: `0x${"ab".repeat(32)}` }];
    expect(pinParams("eth_call", byHash, 100)).toBe(byHash);
    expect(pinParams("eth_call", [TX, { blockNumber: "latest", requireCanonical: true }], 100)).toEqual([
      TX,
      { blockNumber: "0x64", requireCanonical: true },
    ]);
  });

  test("finds the tag at each method's position", () => {
    expect(pinParams("eth_getBalance", [ADDRESS, "latest"], 100)).toEqual([ADDRESS, "0x64"]);
    expect(pinParams("eth_getCode", [ADDRESS], 100)).toEqual([ADDRESS, "0x64"]);
    expect(pinParams("eth_getTransactionCount", [ADDRESS, "latest"], 100)).toEqual([ADDRESS, "0x64"]);
    expect(pinParams("eth_getTransactionCount", [ADDRESS, "pending"], 100)).toEqual([ADDRESS, "pending"]);
    expect(pinParams("eth_getStorageAt", [ADDRESS, "0x0", "latest"], 100)).toEqual([ADDRESS, "0x0", "0x64"]);
    expect(pinParams("eth_getStorageAt", [ADDRESS, "0x0"], 100)).toEqual([ADDRESS, "0x0", "0x64"]);
    expect(pinParams("eth_getBlockByNumber", ["latest", false], 100)).toEqual(["0x64", false]);
    expect(pinParams("eth_feeHistory", ["0x4", "latest", [25, 75]], 100)).toEqual(["0x4", "0x64", [25, 75]]);
    expect(pinParams("eth_estimateGas", [TX, "latest"], 100)).toEqual([TX, "0x64"]);
  });

  test("does not invent a tag where an omitted one may not mean latest", () => {
    const estimate = [TX];
    expect(pinParams("eth_estimateGas", estimate, 100)).toBe(estimate);
    const block = [undefined, false];
    expect(pinParams("eth_getBlockByNumber", block, 100)).toBe(block);
    // A call missing an earlier param is sent as it is.
    const storage = [ADDRESS];
    expect(pinParams("eth_getStorageAt", storage, 100)).toBe(storage);
    const unknown = [TX, "latest"];
    expect(pinParams("eth_getTransactionReceipt", unknown, 100)).toBe(unknown);
    expect(pinParams("eth_call", undefined, 100)).toBeUndefined();
  });

  test("never mutates the caller's params", () => {
    const params = [TX, "latest"];
    const filter = { address: ADDRESS, fromBlock: "0x10" };
    const logs = [filter];
    pinParams("eth_call", params, 100);
    pinParams("eth_getLogs", logs, 100);
    expect(params).toEqual([TX, "latest"]);
    expect(logs).toEqual([{ address: ADDRESS, fromBlock: "0x10" }]);
    expect(filter).toEqual({ address: ADDRESS, fromBlock: "0x10" });
  });

  test("pins an eth_getLogs range without inverting it", () => {
    expect(pinParams("eth_getLogs", [{ address: ADDRESS }], 100)).toEqual([
      { address: ADDRESS, fromBlock: "0x64", toBlock: "0x64" },
    ]);
    expect(pinParams("eth_getLogs", [{ fromBlock: "0x60" }], 100)).toEqual([{ fromBlock: "0x60", toBlock: "0x64" }]);
    expect(pinParams("eth_getLogs", [{ fromBlock: "earliest", toBlock: "latest" }], 100)).toEqual([
      { fromBlock: "earliest", toBlock: "0x64" },
    ]);
    expect(pinParams("eth_getLogs", [{ fromBlock: "0x64", toBlock: "latest" }], 100)).toEqual([
      { fromBlock: "0x64", toBlock: "0x64" },
    ]);
    // A start above the pin, or an end below it, would become an empty or invalid range.
    const above = [{ fromBlock: "0x65" }];
    expect(pinParams("eth_getLogs", above, 100)).toBe(above);
    const below = [{ fromBlock: "latest", toBlock: "0x63" }];
    expect(pinParams("eth_getLogs", below, 100)).toBe(below);
    const byHash = [{ blockHash: `0x${"ab".repeat(32)}` }];
    expect(pinParams("eth_getLogs", byHash, 100)).toBe(byHash);
    const numbers = [{ fromBlock: "0x1", toBlock: "0x2" }];
    expect(pinParams("eth_getLogs", numbers, 100)).toBe(numbers);
    const pending = [{ fromBlock: "pending", toBlock: "pending" }];
    expect(pinParams("eth_getLogs", pending, 100)).toBe(pending);
  });

  test("defaults: off, a 1 second freshness window, and eth_blockNumber answered once on", () => {
    expect(resolvePin(undefined)).toEqual({ enabled: false, freshMs: 1_000, blockNumber: true });
    expect(resolvePin(false).enabled).toBe(false);
    expect(resolvePin(true)).toEqual({ enabled: true, freshMs: 1_000, blockNumber: true });
    expect(resolvePin({ freshMs: 2_500, blockNumber: false })).toEqual({
      enabled: true,
      freshMs: 2_500,
      blockNumber: false,
    });
  });
});

describe("pinLatest", () => {
  test("is off by default", async () => {
    const a = node("a", { value: 102 });
    const client = open({ endpoints: [a.transport], pinLatest: undefined, now: () => 0 });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x66");
    expect(a.reads()).toEqual([{ method: "eth_call", params: [TX, "latest"] }]);
    expect(a.calls.filter((call) => call.method === "eth_blockNumber")).toHaveLength(2);
  });

  test("pins latest to the lowest fresh head and answers eth_blockNumber with it", async () => {
    const a = node("a", { value: 102 });
    const b = node("b", { value: 100 });
    const client = open({ endpoints: [a.transport, b.transport], now: () => 0 });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    await client.request({ method: "eth_getLogs", params: [{ address: ADDRESS }] });
    await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    expect([...a.reads(), ...b.reads()].map((call) => call.params)).toEqual([
      [TX, "0x64"],
      [{ address: ADDRESS, fromBlock: "0x64", toBlock: "0x64" }],
      ["0x64", false],
    ]);
    const probes = a.calls.length + b.calls.length;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.length + b.calls.length).toBe(probes);
  });

  test("passes latest through once the heads are older than freshMs", async () => {
    let nowMs = 0;
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [a.transport], pinLatest: { freshMs: 500 }, now: () => nowMs });
    await client.value.probe();
    nowMs = 400;
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    nowMs = 501;
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(a.reads().map((call) => call.params)).toEqual([
      [TX, "0x64"],
      [TX, "latest"],
    ]);
    // No fresh head: eth_blockNumber goes upstream, and its answer is a fresh head again.
    const before = a.calls.length;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.length).toBe(before + 1);
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.length).toBe(before + 1);
  });

  test("leaves an endpoint past maxLag out of the floor", async () => {
    const a = node("a", { value: 110 });
    const b = node("b", { value: 100 });
    const client = open({ endpoints: [a.transport, b.transport], now: () => 0 });
    await client.value.probe();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x6e");
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect([...a.reads(), ...b.reads()].map((call) => call.params)).toEqual([[TX, "0x6e"]]);
  });

  test("an ignored head does not pin", async () => {
    const a = node("a", { value: 100 });
    const liar = node("liar", { value: 100_000 });
    const client = open({ endpoints: [a.transport, liar.transport], now: () => 0 });
    await client.value.probe();
    // Two heads that far apart leave no reference, so neither is trusted.
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect([...a.reads(), ...liar.reads()].map((call) => call.params)).toEqual([[TX, "latest"]]);
  });

  test("an ejected endpoint's head does not hold the pin down, and nothing is sent to it", async () => {
    let nowMs = 0;
    let failing = true;
    const low = mockEndpoint("low", (method) => {
      if (method === "eth_blockNumber") return "0x64";
      if (failing) throw new Error("upstream unavailable");
      return "0x1";
    });
    const high = node("high", { value: 102 });
    const client = open({
      endpoints: [low.transport, high.transport],
      breaker: { threshold: 1, cooldown: 5_000 },
      now: () => nowMs,
    });
    await client.value.probe();
    // The first read is pinned to low's head, fails there, and fails over with the same block.
    await client.request({ method: "eth_call", params: [TX] });
    expect(low.reads().map((call) => call.params)).toEqual([[TX, "0x64"]]);
    expect(high.reads().map((call) => call.params)).toEqual([[TX, "0x64"]]);
    // low is ejected now. The floor is high's head alone.
    await client.request({ method: "eth_call", params: [TX] });
    expect(high.reads().map((call) => call.params)).toEqual([
      [TX, "0x64"],
      [TX, "0x66"],
    ]);
    expect(low.reads()).toHaveLength(1);
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x66");
    // Back after the cooldown, low holds the pin down again. eth_blockNumber does not go backwards.
    failing = false;
    nowMs = 5_000;
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    expect([...low.reads().slice(1), ...high.reads().slice(2)].map((call) => call.params)).toEqual([[TX, "0x64"]]);
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x66");
  });

  test("only chain-verified endpoints pin", async () => {
    const a = node("a", { value: 100 });
    const other = node("other", { value: 90 }, "0x1");
    const client = open({ endpoints: [other.transport, a.transport], verifyChainId: true, now: () => 0 });
    await client.value.probe();
    expect(other.calls.map((call) => call.method)).toEqual(["eth_chainId"]);
    expect(client.value.snapshot().map((entry) => entry.quarantined)).toEqual([true, false]);
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(a.reads().map((call) => call.params)).toEqual([[TX, "0x64"]]);
  });

  test("an unverified endpoint passes its chain check before its head can pin", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [a.transport], verifyChainId: true, now: () => 0 });
    // No heads yet: the call goes upstream, after the check, unpinned.
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.map((call) => call.method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.reads().map((call) => call.params)).toEqual([[TX, "0x64"]]);
  });

  test("is a no-op with headLag disabled", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [a.transport], headLag: false, now: () => 0 });
    await client.value.probe();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(a.calls.filter((call) => call.method === "eth_blockNumber")).toHaveLength(3);
    expect(a.reads().map((call) => call.params)).toEqual([[TX, "latest"]]);
  });

  test("with the probe timer off, heads come from responses", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [a.transport], now: () => 0 });
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.filter((call) => call.method === "eth_blockNumber")).toHaveLength(1);
    expect(a.reads().map((call) => call.params)).toEqual([
      [TX, "latest"],
      [TX, "0x64"],
    ]);
  });

  test("an upstream eth_blockNumber never goes behind one already returned", async () => {
    let nowMs = 0;
    // One URL in front of several nodes can answer from a node behind the last one.
    const head = { value: 105 };
    const balanced = node("balanced", head);
    const client = open({ endpoints: [balanced.transport], pinLatest: { freshMs: 100 }, now: () => nowMs });
    await client.value.probe();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x69");
    nowMs = 1_000;
    head.value = 103;
    const before = balanced.calls.length;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x69");
    expect(balanced.calls.length).toBe(before + 1);
    head.value = 107;
    nowMs = 2_000;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x6b");
  });

  test("leaves non-idempotent methods alone", async () => {
    const a = node("a", { value: 100 });
    const client = open({
      endpoints: [a.transport],
      nonIdempotentMethods: ["eth_call", "eth_blockNumber"],
      now: () => 0,
    });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(a.reads().map((call) => call.params)).toEqual([[TX, "latest"]]);
    const before = a.calls.length;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.length).toBe(before + 1);
  });

  test("blockNumber: false keeps eth_blockNumber upstream and still pins reads", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [a.transport], pinLatest: { blockNumber: false }, now: () => 0 });
    await client.value.probe();
    const before = a.calls.length;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.calls.length).toBe(before + 1);
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.reads().map((call) => call.params)).toEqual([[TX, "0x64"]]);
  });

  test("a local eth_blockNumber still honors an aborted signal", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [a.transport], now: () => 0 });
    await client.value.probe();
    const before = a.calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(client.request({ method: "eth_blockNumber" }, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(a.calls.length).toBe(before);
  });

  test("a hedge answers for the same pinned block", async () => {
    const a = mockEndpoint("a", async (method) => {
      if (method === "eth_blockNumber") return "0x64";
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "slow";
    });
    const b = node("b", { value: 100 });
    const client = open({ endpoints: [a.transport, b.transport], hedge: { minDelay: 10 }, now: () => 0 });
    await client.value.probe();
    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect([...a.reads(), ...b.reads()].map((call) => call.params)).toEqual([
      [TX, "0x64"],
      [TX, "0x64"],
    ]);
  });
});

describe("split nodes", () => {
  /**
   * A node at `head` that serves `eth_getLogs` only over blocks it holds, as a real node does: a range that
   * starts past its head is invalid params. `flaky` fails the first read so the call moves to the next node.
   */
  function logsNode(name: string, head: number, flaky: boolean): MockEndpoint {
    let failed = !flaky;
    return mockEndpoint(name, (method, params) => {
      if (method === "eth_blockNumber") return hex(head);
      if (method !== "eth_getLogs") return "0x1";
      if (!failed) {
        failed = true;
        throw new Error("upstream unavailable");
      }
      const filter = (params as [{ fromBlock?: string; toBlock?: string }])[0];
      const from = filter.fromBlock === undefined || filter.fromBlock === "latest" ? head : Number(filter.fromBlock);
      const to = filter.toBlock === undefined || filter.toBlock === "latest" ? head : Number(filter.toBlock);
      if (from > head || to > head) throw Object.assign(new Error("invalid block range params"), { code: -32602 });
      return [{ blockNumber: hex(to) }];
    });
  }

  test("without pinning, eth_blockNumber from one node and eth_getLogs on another disagree", async () => {
    const ahead = logsNode("ahead", 105, true);
    const behind = logsNode("behind", 103, false);
    const client = open({ endpoints: [ahead.transport, behind.transport], pinLatest: false, now: () => 0 });
    await client.value.probe();
    const head = await client.request({ method: "eth_blockNumber" });
    expect(head).toBe("0x69");
    await expect(client.request({ method: "eth_getLogs", params: [{ fromBlock: head }] })).rejects.toThrow(
      /invalid block range/,
    );
  });

  test("with pinning, the block eth_blockNumber returns is one the next eth_getLogs is served at", async () => {
    const ahead = logsNode("ahead", 105, true);
    const behind = logsNode("behind", 103, false);
    const client = open({ endpoints: [ahead.transport, behind.transport], now: () => 0 });
    await client.value.probe();
    const head = await client.request({ method: "eth_blockNumber" });
    expect(head).toBe("0x67");
    expect(await client.request({ method: "eth_getLogs", params: [{ fromBlock: head }] })).toEqual([
      { blockNumber: "0x67" },
    ]);
    // The failed attempt on the node ahead and the failover both asked for the same block.
    expect([...ahead.reads(), ...behind.reads()].map((call) => call.params)).toEqual([
      [{ fromBlock: "0x67", toBlock: "0x67" }],
      [{ fromBlock: "0x67", toBlock: "0x67" }],
    ]);
  });
});
