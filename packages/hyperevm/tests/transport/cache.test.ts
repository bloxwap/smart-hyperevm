/**
 * The block-bounded read cache: what is served from memory, how stale it may be, what is never cached, how hot
 * keys are refreshed on new heads, the incremental log index, and the local `eth_blockNumber`.
 */
import { describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { planFor, resolveCache } from "../../src/transport/_cache.ts";
import {
  type HyperevmEvent,
  type HyperevmTransportOptions,
  type HyperevmTransportValue,
  hyperevm,
} from "../../src/transport/mod.ts";

interface Call {
  method: string;
  params: unknown;
}

interface MockEndpoint {
  transport: Transport;
  calls: Call[];
  /** Calls other than chain checks and head probes. */
  reads: () => Call[];
  count: (method: string) => number;
}

/** Answers chain 999, `eth_blockNumber` with `head.value`, and everything else through `read` (default `0x1`). */
function node(
  name: string,
  head: { value: number },
  read: (method: string, params: unknown) => unknown | Promise<unknown> = () => "0x1",
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
        if (method === "eth_chainId") return "0x3e7";
        if (method === "eth_blockNumber") return hex(head.value);
        return read(method, params);
      }) as EIP1193RequestFn,
    });
  return {
    transport,
    calls,
    reads: () => calls.filter((call) => call.method !== "eth_chainId" && call.method !== "eth_blockNumber"),
    count: (method) => calls.filter((call) => call.method === method).length,
  };
}

interface Opened {
  request: ReturnType<Transport>["request"];
  value: HyperevmTransportValue;
  events: HyperevmEvent[];
}

const START = 10_000_000;

/** A client with the cache on, pinning, no ticks, and the test's clock. Heads stay fresh while the clock stands. */
function open(options: HyperevmTransportOptions & { clock?: { now: number } } = {}): Opened {
  const clock = options.clock ?? { now: START };
  const events: HyperevmEvent[] = [];
  const transport = hyperevm({
    routing: "best",
    retryCount: 2,
    hedge: false,
    verifyChainId: false,
    headLag: { probeInterval: false },
    pinLatest: true,
    cache: { refreshInterval: false },
    now: () => clock.now,
    onEvent: (event) => events.push(event),
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
  if (!transport.value) throw new Error("hyperevm() returned no transport value.");
  return { request: transport.request, value: transport.value, events };
}

const TX = { to: "0x000000000000000000000000000000000000dead", data: "0x" };
const PRECOMPILE = { to: "0x0000000000000000000000000000000000000809", data: "0x" };
const ADDRESS = "0x233ff29b239abc1d7748605da9b205c3e008626e";
const HASH = `0x${"ab".repeat(32)}`;

function hex(block: number): string {
  return `0x${block.toString(16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once `condition` holds, polling every few milliseconds, or fail after `ms`. */
async function until(condition: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time.");
    await sleep(2);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function cacheEvents(events: readonly HyperevmEvent[]): { outcome: string; staleBlocks: number | null }[] {
  return events.flatMap((event) =>
    event.type === "cache" ? [{ outcome: event.outcome, staleBlocks: event.staleBlocks }] : [],
  );
}

/** A log of `address` at `block`, with `logIndex` within it. */
function log(block: number, logIndex: number): Record<string, unknown> {
  return { address: ADDRESS, blockNumber: hex(block), logIndex: hex(logIndex), topics: [], data: "0x" };
}

/** A node that answers `eth_getLogs` from a fixed table, for the blocks the filter names. */
function logsNode(name: string, head: { value: number }, table: readonly Record<string, unknown>[]): MockEndpoint {
  return node(name, head, (method, params) => {
    if (method !== "eth_getLogs") return "0x1";
    const filter = (params as [{ fromBlock: string; toBlock: string }])[0];
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = filter.toBlock === "latest" ? head.value : Number.parseInt(filter.toBlock, 16);
    return table.filter((entry) => {
      const block = Number.parseInt(entry.blockNumber as string, 16);
      return block >= from && block <= to;
    });
  });
}

describe("resolveCache", () => {
  test("defaults, and off unless set", () => {
    expect(resolveCache(undefined).enabled).toBe(false);
    expect(resolveCache(false).enabled).toBe(false);
    expect(resolveCache(true)).toEqual({
      enabled: true,
      maxStaleBlocks: 1,
      maxAgeMs: 2_000,
      refreshInterval: 1_000,
      hotKeys: 64,
      hotIdleMs: 30_000,
      maxEntries: 1_000,
      maxBytes: 8 * 1024 * 1024,
      logsWindow: 1_000,
    });
    expect(resolveCache({ maxStaleBlocks: 0, refreshInterval: false }).maxStaleBlocks).toBe(0);
  });

  test("rejects values that cannot bound anything", () => {
    expect(() => resolveCache({ maxStaleBlocks: -1 })).toThrow("cache.maxStaleBlocks");
    expect(() => resolveCache({ maxAgeMs: Number.NaN })).toThrow("cache.maxAgeMs");
    expect(() => resolveCache({ refreshInterval: 0 })).toThrow("cache.refreshInterval");
    expect(() => resolveCache({ logsWindow: 0 })).toThrow("cache.logsWindow");
  });
});

describe("planFor", () => {
  test("implied latest, explicit latest, and a block number share one key; the number is kept aside", () => {
    const implied = planFor("eth_call", [TX]);
    const explicit = planFor("eth_call", [TX, "latest"]);
    const numbered = planFor("eth_call", [TX, "0x64"]);
    expect(implied?.kind).toBe("latest");
    expect(explicit?.key).toBe(implied?.key);
    expect(numbered).toMatchObject({ kind: "number", key: implied?.key, block: 100, guard: true });
    expect(planFor("eth_call", [{ ...TX, to: TX.to.toUpperCase() }])?.key).toBe(implied?.key);
    expect(planFor("eth_call", [TX, "latest", { [ADDRESS]: {} }])?.key).not.toBe(implied?.key);
  });

  test("what is never planned", () => {
    expect(planFor("eth_getTransactionCount", [ADDRESS, "latest"])).toBeUndefined();
    expect(planFor("eth_getTransactionCount", [ADDRESS, "pending"])).toBeUndefined();
    expect(planFor("eth_getTransactionCount", [ADDRESS])).toBeUndefined();
    expect(planFor("eth_estimateGas", [TX])).toBeUndefined();
    expect(planFor("eth_gasPrice", [])).toBeUndefined();
    expect(planFor("eth_feeHistory", ["0x4", "latest", []])).toBeUndefined();
    expect(planFor("eth_call", [TX, "pending"])).toBeUndefined();
    expect(planFor("eth_getBlockByNumber", ["safe", false])).toBeUndefined();
    expect(planFor("eth_getFilterChanges", ["0x1"])).toBeUndefined();
    expect(planFor("eth_sendRawTransaction", ["0x00"])).toBeUndefined();
    expect(planFor("eth_getLogs", [{ fromBlock: "pending" }])).toBeUndefined();
  });

  test("precompile calls, reads by hash, nonces at a number, and log filters", () => {
    expect(planFor("eth_call", [PRECOMPILE])?.kind).toBe("timed");
    expect(planFor("eth_call", [PRECOMPILE, "0x64"])?.key).toBe(planFor("eth_call", [PRECOMPILE])?.key);
    expect(planFor("eth_getTransactionReceipt", [HASH])?.kind).toBe("immutable");
    expect(planFor("eth_call", [TX, { blockHash: HASH }])?.kind).toBe("immutable");
    expect(planFor("eth_getTransactionCount", [ADDRESS, "0x10"])).toMatchObject({ kind: "number", block: 16 });
    expect(planFor("eth_getLogs", [{ address: ADDRESS, fromBlock: "0x5a" }])).toMatchObject({
      kind: "logs",
      from: 90,
      to: "latest",
    });
    expect(planFor("eth_getLogs", [{ blockHash: HASH }])?.kind).toBe("immutable");
  });
});

describe("latest reads", () => {
  test("the second read is served from memory, as a copy, and spellings of latest share it", async () => {
    const head = { value: 100 };
    let answers = 0;
    const a = node("a", head, () => {
      answers += 1;
      return { nested: { n: answers } };
    });
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();

    const first = (await client.request({ method: "eth_call", params: [TX] })) as { nested: { n: number } };
    expect(first).toEqual({ nested: { n: 1 } });
    first.nested.n = 99;
    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toEqual({ nested: { n: 1 } });
    expect(await client.request({ method: "eth_call", params: [TX, "0x64"] })).toEqual({ nested: { n: 1 } });
    expect(a.reads()).toEqual([{ method: "eth_call", params: [TX, "0x64"] }]);
    expect(client.value.cacheStats()).toMatchObject({ hits: 2, misses: 1, entries: 1, hotKeys: 1 });
    expect(cacheEvents(client.events)).toEqual([
      { outcome: "miss", staleBlocks: null },
      { outcome: "hit", staleBlocks: 0 },
      { outcome: "hit", staleBlocks: 0 },
    ]);
  });

  test("served within maxStaleBlocks of the newest head, and not past it", async () => {
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], isActive: () => false });
    await client.value.probe();
    await client.request({ method: "eth_getBalance", params: [ADDRESS] });

    head.value = 101;
    await client.value.probe();
    await client.request({ method: "eth_getBalance", params: [ADDRESS] });
    expect(a.count("eth_getBalance")).toBe(1);
    expect(cacheEvents(client.events).at(-1)).toEqual({ outcome: "hit", staleBlocks: 1 });

    head.value = 102;
    await client.value.probe();
    await client.request({ method: "eth_getBalance", params: [ADDRESS] });
    expect(a.count("eth_getBalance")).toBe(2);
    expect(a.reads().at(-1)).toEqual({ method: "eth_getBalance", params: [ADDRESS, "0x66"] });
  });

  test("maxStaleBlocks 0 serves only answers at the newest head", async () => {
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      cache: { maxStaleBlocks: 0, refreshInterval: false },
      isActive: () => false,
    });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    head.value = 101;
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call")).toBe(2);
  });

  test("an answer older than maxAgeMs goes upstream whatever the head", async () => {
    const clock = { now: START };
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], clock, isActive: () => false });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    clock.now += 2_001;
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call")).toBe(2);
  });

  test("a block fetched at latest is stamped with its own number", async () => {
    const head = { value: 100 };
    const a = node("a", head, (method) => (method === "eth_getBlockByNumber" ? { number: "0x63", hash: HASH } : "0x1"));
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], isActive: () => false });
    await client.value.probe();
    await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    expect(cacheEvents(client.events)).toEqual([{ outcome: "miss", staleBlocks: null }]);
    // Block 99 by number is the same block.
    expect(await client.request({ method: "eth_getBlockByNumber", params: ["0x63", false] })).toEqual({
      number: "0x63",
      hash: HASH,
    });
    expect(cacheEvents(client.events).at(-1)).toEqual({ outcome: "hit", staleBlocks: 0 });
    expect(a.count("eth_getBlockByNumber")).toBe(1);
  });

  test("without pinning, an answer is stamped with the block every endpoint holds", async () => {
    const a = node("a", { value: 100 });
    const b = node("b", { value: 98 });
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      pinLatest: false,
      isActive: () => false,
    });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    // Stamped at 98, the newest head is 100: two blocks stale, so it is not served.
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call") + b.count("eth_call")).toBe(2);
  });

  test("errors are never cached", async () => {
    const head = { value: 100 };
    let fail = true;
    const a = node("a", head, () => {
      if (fail) throw Object.assign(new Error("execution reverted"), { code: 3 });
      return "0x1";
    });
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();
    await expect(client.request({ method: "eth_call", params: [TX] })).rejects.toThrow("execution reverted");
    fail = false;
    expect(await client.request({ method: "eth_call", params: [TX] })).toBe("0x1");
    expect(await client.request({ method: "eth_call", params: [TX] })).toBe("0x1");
    expect(a.count("eth_call")).toBe(2);
    expect(client.value.cacheStats()).toMatchObject({ hits: 1, misses: 2 });
  });
});

describe("what is never cached", () => {
  test("nonces at latest, gas, sends, and filters go upstream every time", async () => {
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();
    const calls: { method: string; params: unknown }[] = [
      { method: "eth_getTransactionCount", params: [ADDRESS, "latest"] },
      { method: "eth_getTransactionCount", params: [ADDRESS, "pending"] },
      { method: "eth_estimateGas", params: [TX] },
      { method: "eth_gasPrice", params: [] },
      { method: "eth_sendRawTransaction", params: ["0x00"] },
      { method: "eth_getFilterLogs", params: ["0x1"] },
    ];
    for (const call of calls) {
      const before = a.count(call.method);
      await client.request(call);
      await client.request(call);
      expect(a.count(call.method)).toBe(before + 2);
    }
    expect(client.value.cacheStats()).toMatchObject({ hits: 0, misses: 0, entries: 0 });
  });

  test("a method listed in nonIdempotentMethods is not cached", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], nonIdempotentMethods: ["eth_call"] });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call")).toBe(2);
  });
});

describe("precompile reads", () => {
  test("bounded by maxAgeMs, not by the head, and shared across block tags", async () => {
    const clock = { now: START };
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], clock, isActive: () => false });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [PRECOMPILE] });
    head.value = 110;
    await client.value.probe();
    await client.request({ method: "eth_call", params: [PRECOMPILE, "latest"] });
    await client.request({ method: "eth_call", params: [PRECOMPILE, "0x64"] });
    expect(a.count("eth_call")).toBe(1);
    expect(cacheEvents(client.events).at(-1)).toEqual({ outcome: "hit", staleBlocks: null });
    clock.now += 2_001;
    await client.request({ method: "eth_call", params: [PRECOMPILE] });
    expect(a.count("eth_call")).toBe(2);
  });
});

describe("immutable reads", () => {
  test("a receipt, a block by hash, and a block by number are kept; null is not", async () => {
    const head = { value: 100 };
    let receipt: unknown = null;
    const a = node("a", head, (method) => {
      if (method === "eth_getTransactionReceipt") return receipt;
      if (method === "eth_getBlockByHash") return { number: "0x60", hash: HASH };
      if (method === "eth_getBlockByNumber") return { number: "0x60", hash: HASH };
      return "0x1";
    });
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();
    expect(await client.request({ method: "eth_getTransactionReceipt", params: [HASH] })).toBeNull();
    receipt = { blockNumber: "0x60", status: "0x1" };
    expect(await client.request({ method: "eth_getTransactionReceipt", params: [HASH] })).toEqual(receipt);
    expect(await client.request({ method: "eth_getTransactionReceipt", params: [HASH] })).toEqual(receipt);
    expect(a.count("eth_getTransactionReceipt")).toBe(2);

    await client.request({ method: "eth_getBlockByHash", params: [HASH, false] });
    await client.request({ method: "eth_getBlockByHash", params: [HASH, false] });
    expect(a.count("eth_getBlockByHash")).toBe(1);

    head.value = 200;
    await client.value.probe();
    await client.request({ method: "eth_getBlockByNumber", params: ["0x60", false] });
    await client.request({ method: "eth_getBlockByNumber", params: ["0x60", false] });
    expect(a.count("eth_getBlockByNumber")).toBe(1);
  });

  test("a state read at a block number is kept only when every endpoint holds that block", async () => {
    const a = node("a", { value: 100 });
    const b = node("b", { value: 98 });
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
    });
    await client.value.probe();
    // Block 99: b may have answered from current state. Not kept.
    await client.request({ method: "eth_getBalance", params: [ADDRESS, "0x63"] });
    await client.request({ method: "eth_getBalance", params: [ADDRESS, "0x63"] });
    expect(a.count("eth_getBalance") + b.count("eth_getBalance")).toBe(2);
    // Block 98: both hold it.
    await client.request({ method: "eth_getBalance", params: [ADDRESS, "0x62"] });
    await client.request({ method: "eth_getBalance", params: [ADDRESS, "0x62"] });
    expect(a.count("eth_getBalance") + b.count("eth_getBalance")).toBe(3);
  });

  test("a pending transaction by hash is not kept until it is mined", async () => {
    let mined = false;
    const a = node("a", { value: 100 }, () => ({ hash: HASH, blockNumber: mined ? "0x60" : null }));
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();
    await client.request({ method: "eth_getTransactionByHash", params: [HASH] });
    await client.request({ method: "eth_getTransactionByHash", params: [HASH] });
    expect(a.count("eth_getTransactionByHash")).toBe(2);
    mined = true;
    await client.request({ method: "eth_getTransactionByHash", params: [HASH] });
    await client.request({ method: "eth_getTransactionByHash", params: [HASH] });
    expect(a.count("eth_getTransactionByHash")).toBe(3);
  });
});

describe("eth_getLogs index", () => {
  const TABLE = [log(80, 0), log(95, 0), log(100, 1), log(100, 0), log(101, 0), log(103, 2), log(103, 0)];

  test("seeded by a range query, extended by the new blocks only, and answered in order from memory", async () => {
    const head = { value: 100 };
    const a = logsNode("a", head, TABLE);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();
    const filter = { address: ADDRESS, fromBlock: hex(90), toBlock: "latest" };

    expect(await client.request({ method: "eth_getLogs", params: [filter] })).toEqual([
      log(95, 0),
      log(100, 1),
      log(100, 0),
    ]);
    expect(a.reads()).toEqual([{ method: "eth_getLogs", params: [{ ...filter, toBlock: "0x64" }] }]);

    // A new head: the refresh fetches blocks 101 to 101 only.
    head.value = 101;
    await client.value.probe();
    await until(() => a.count("eth_getLogs") === 2);
    await until(() => client.value.cacheStats().refreshes === 1);
    expect(a.reads().at(-1)).toEqual({
      method: "eth_getLogs",
      params: [{ address: ADDRESS, fromBlock: "0x65", toBlock: "0x65" }],
    });
    await sleep(5);
    expect(await client.request({ method: "eth_getLogs", params: [filter] })).toEqual([
      log(95, 0),
      log(100, 0),
      log(100, 1),
      log(101, 0),
    ]);
    expect(
      await client.request({ method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(96), toBlock: hex(100) }] }),
    ).toEqual([log(100, 0), log(100, 1)]);
    expect(a.count("eth_getLogs")).toBe(2);
    expect(cacheEvents(client.events).at(-1)).toEqual({ outcome: "hit", staleBlocks: 0 });
  });

  test("a query the index does not reach goes upstream and widens it", async () => {
    const head = { value: 100 };
    const a = logsNode("a", head, TABLE);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], isActive: () => false });
    await client.value.probe();
    await client.request({
      method: "eth_getLogs",
      params: [{ address: ADDRESS, fromBlock: hex(90), toBlock: "latest" }],
    });
    expect(
      await client.request({
        method: "eth_getLogs",
        params: [{ address: ADDRESS, fromBlock: hex(70), toBlock: "latest" }],
      }),
    ).toEqual([log(80, 0), log(95, 0), log(100, 1), log(100, 0)]);
    expect(a.count("eth_getLogs")).toBe(2);
    expect(
      await client.request({
        method: "eth_getLogs",
        params: [{ address: ADDRESS, fromBlock: hex(75), toBlock: hex(99) }],
      }),
    ).toEqual([log(80, 0), log(95, 0)]);
    expect(a.count("eth_getLogs")).toBe(2);
    // Another filter is another index.
    await client.request({ method: "eth_getLogs", params: [{ address: ADDRESS, topics: [HASH], fromBlock: hex(90) }] });
    expect(a.count("eth_getLogs")).toBe(3);
  });

  test("a miss whose index covers the start fetches the missing tail and answers from memory", async () => {
    const head = { value: 100 };
    const a = logsNode("a", head, TABLE);
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      cache: { maxStaleBlocks: 0, refreshInterval: false },
      isActive: () => false,
    });
    await client.value.probe();
    const filter = { address: ADDRESS, fromBlock: hex(90), toBlock: "latest" };
    await client.request({ method: "eth_getLogs", params: [filter] });
    head.value = 103;
    await client.value.probe();
    expect(await client.request({ method: "eth_getLogs", params: [filter] })).toEqual([
      log(95, 0),
      log(100, 0),
      log(100, 1),
      log(101, 0),
      log(103, 0),
      log(103, 2),
    ]);
    expect(a.reads().at(-1)).toEqual({
      method: "eth_getLogs",
      params: [{ address: ADDRESS, fromBlock: "0x65", toBlock: "0x67" }],
    });
    expect(a.count("eth_getLogs")).toBe(2);
  });

  test("the index keeps logsWindow blocks", async () => {
    const head = { value: 100 };
    const a = logsNode("a", head, TABLE);
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      cache: { logsWindow: 5, refreshInterval: false },
      isActive: () => false,
    });
    await client.value.probe();
    await client.request({
      method: "eth_getLogs",
      params: [{ address: ADDRESS, fromBlock: hex(90), toBlock: "latest" }],
    });
    // Blocks 96 to 100 are kept, so a query from 95 goes upstream.
    await client.request({
      method: "eth_getLogs",
      params: [{ address: ADDRESS, fromBlock: hex(97), toBlock: hex(100) }],
    });
    expect(a.count("eth_getLogs")).toBe(1);
    await client.request({
      method: "eth_getLogs",
      params: [{ address: ADDRESS, fromBlock: hex(95), toBlock: hex(100) }],
    });
    expect(a.count("eth_getLogs")).toBe(2);
  });

  test("a filter by block hash is kept for good", async () => {
    const a = logsNode("a", { value: 100 }, TABLE);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    await client.value.probe();
    await client.request({ method: "eth_getLogs", params: [{ address: ADDRESS, blockHash: HASH }] });
    await client.request({ method: "eth_getLogs", params: [{ address: ADDRESS, blockHash: HASH }] });
    expect(a.count("eth_getLogs")).toBe(1);
  });
});

describe("background refresh", () => {
  test("the refresh follows the head: pinned to the top, to its holders only, never raced", async () => {
    const headA = { value: 100 };
    const headB = { value: 100 };
    const a = node("a", headA);
    const b = node("b", headB);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      race: true,
    });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    const raced = a.count("eth_call") + b.count("eth_call");
    expect(raced).toBe(2);

    headA.value = 101;
    await client.value.probe();
    await until(() => a.count("eth_call") === 2);
    await sleep(5);
    expect(a.reads().at(-1)).toEqual({ method: "eth_call", params: [TX, "0x65"] });
    expect(b.count("eth_call")).toBe(1);
    expect(client.value.cacheStats()).toMatchObject({ refreshes: 1 });
    expect(cacheEvents(client.events).at(-1)).toEqual({ outcome: "refresh", staleBlocks: null });

    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call") + b.count("eth_call")).toBe(3);
    expect(cacheEvents(client.events).at(-1)).toEqual({ outcome: "hit", staleBlocks: 0 });
  });

  test("a read that misses joins the refresh in flight", async () => {
    const head = { value: 100 };
    const gate = deferred<string>();
    let answers = 0;
    const a = node("a", head, () => {
      answers += 1;
      return answers === 1 ? "0x1" : gate.promise;
    });
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      cache: { maxStaleBlocks: 0, refreshInterval: false },
    });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    head.value = 101;
    await client.value.probe();
    await until(() => a.count("eth_call") === 2);
    const joined = client.request({ method: "eth_call", params: [TX] });
    await until(() => client.events.some((event) => event.type === "coalesce"));
    gate.resolve("0x2");
    expect(await joined).toBe("0x2");
    expect(a.count("eth_call")).toBe(2);
    expect(await client.request({ method: "eth_call", params: [TX] })).toBe("0x2");
    expect(a.count("eth_call")).toBe(2);
  });

  test("nothing is refreshed while the page is hidden, or without a budget token", async () => {
    const head = { value: 100 };
    const a = node("a", head);
    let active = false;
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], isActive: () => active });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    head.value = 101;
    await client.value.probe();
    await sleep(10);
    expect(a.count("eth_call")).toBe(1);

    active = true;
    const spent = node("s", head);
    const budgeted = open({
      endpoints: [{ transport: spent.transport, label: "s", rps: 1, burst: 3 }],
      pinLatest: false,
    });
    await budgeted.value.probe();
    await budgeted.request({ method: "eth_call", params: [TX] });
    await budgeted.request({ method: "eth_getBalance", params: [ADDRESS] });
    expect(budgeted.value.snapshot()[0]?.tokens).toBe(0);
    head.value = 102;
    await budgeted.value.probe();
    await sleep(10);
    expect(spent.count("eth_call")).toBe(1);
    expect(spent.count("eth_getBalance")).toBe(1);
  });

  test("a failed refresh keeps the entry, and the key stays hot", async () => {
    const head = { value: 100 };
    let fail = false;
    const a = node("a", head, () => {
      if (fail) throw new Error("boom");
      return "0x1";
    });
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], retryCount: 0 });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    fail = true;
    head.value = 101;
    await client.value.probe();
    await until(() => a.count("eth_call") === 2);
    await sleep(5);
    expect(client.value.cacheStats()).toMatchObject({ entries: 1, hotKeys: 1 });
    // Within maxStaleBlocks, the old entry still serves.
    expect(await client.request({ method: "eth_call", params: [TX] })).toBe("0x1");
    expect(a.count("eth_call")).toBe(2);
  });

  test("the tick probes one endpoint per interval, refreshes precompile reads, and stops once keys go idle", async () => {
    const clock = { now: START };
    const head = { value: 100 };
    const a = node("a", head);
    const b = node("b", head);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      cache: { refreshInterval: 10, hotIdleMs: 50 },
      clock,
    });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [PRECOMPILE] });
    await until(() => a.count("eth_blockNumber") + b.count("eth_blockNumber") >= 4, 2_000);
    // Each tick probed one endpoint and re-read the precompile.
    await until(() => a.count("eth_call") + b.count("eth_call") >= 3, 2_000);
    expect(client.value.cacheStats().refreshes).toBeGreaterThanOrEqual(2);

    clock.now += 51;
    await sleep(30);
    const probes = a.count("eth_blockNumber") + b.count("eth_blockNumber");
    const reads = a.count("eth_call") + b.count("eth_call");
    await sleep(40);
    expect(client.value.cacheStats().hotKeys).toBe(0);
    expect(a.count("eth_blockNumber") + b.count("eth_blockNumber")).toBe(probes);
    expect(a.count("eth_call") + b.count("eth_call")).toBe(reads);
    client.value.close();
  });

  test("the tick restarts on the next read, and close() stops it", async () => {
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], cache: { refreshInterval: 10 } });
    await client.value.probe();
    expect(a.count("eth_blockNumber")).toBe(1);
    await sleep(30);
    // No hot key, no tick.
    expect(a.count("eth_blockNumber")).toBe(1);
    await client.request({ method: "eth_call", params: [TX] });
    await until(() => a.count("eth_blockNumber") >= 3, 2_000);
    client.value.close();
    await sleep(5);
    const probes = a.count("eth_blockNumber");
    await sleep(40);
    expect(a.count("eth_blockNumber")).toBe(probes);
  });
});

describe("eth_blockNumber", () => {
  test("answered from the newest head within maxAgeMs, never backwards, upstream once it is older", async () => {
    const clock = { now: START };
    const head = { value: 100 };
    const a = node("a", head);
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], pinLatest: false, clock });
    await client.value.probe();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.count("eth_blockNumber")).toBe(1);
    clock.now += 2_001;
    head.value = 103;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x67");
    expect(a.count("eth_blockNumber")).toBe(2);
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x67");
    expect(a.count("eth_blockNumber")).toBe(2);
  });

  test("with pinLatest, the pinned block wins while a head is fresh", async () => {
    const clock = { now: START };
    const a = node("a", { value: 100 });
    const b = node("b", { value: 101 });
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      clock,
      pinLatest: { freshMs: 500 },
    });
    await client.value.probe();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    // Past freshMs the pin has no target. The cache answers the newest head, lowered to the floor by the pin.
    clock.now += 600;
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x65");
    expect(a.count("eth_blockNumber") + b.count("eth_blockNumber")).toBe(2);
  });
});

describe("bounds and isolation", () => {
  test("entries are capped by count and bytes, least recently used first", async () => {
    const a = node("a", { value: 100 }, (_method, params) => `0x${(params as [{ data: string }])[0].data.slice(2)}`);
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      cache: { maxEntries: 2, refreshInterval: false },
    });
    await client.value.probe();
    const call = (data: string) => client.request({ method: "eth_call", params: [{ ...TX, data }] });
    await call("0x01");
    await call("0x02");
    await call("0x01");
    await call("0x03");
    expect(client.value.cacheStats().entries).toBe(2);
    await call("0x01");
    await call("0x02");
    expect(a.count("eth_call")).toBe(4);

    const big = node("b", { value: 100 }, () => `0x${"ff".repeat(100)}`);
    const small = open({
      endpoints: [{ transport: big.transport, label: "b" }],
      cache: { maxBytes: 600, refreshInterval: false },
    });
    await small.value.probe();
    await small.request({ method: "eth_call", params: [TX] });
    expect(small.value.cacheStats()).toMatchObject({ entries: 1 });
    await small.request({ method: "eth_getBalance", params: [ADDRESS] });
    expect(small.value.cacheStats().entries).toBe(1);
    expect(small.value.cacheStats().bytes).toBeLessThanOrEqual(600);
  });

  test("the hot list is capped, least recently read first", async () => {
    const a = node("a", { value: 100 });
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      cache: { hotKeys: 2, refreshInterval: false },
    });
    await client.value.probe();
    for (const data of ["0x01", "0x02", "0x03"])
      await client.request({ method: "eth_call", params: [{ ...TX, data }] });
    expect(client.value.cacheStats()).toMatchObject({ hotKeys: 2, entries: 3 });
  });

  test("two factories never share an answer", async () => {
    const a = node("a", { value: 100 }, () => "0xa");
    const b = node("b", { value: 100 }, () => "0xb");
    const first = open({ endpoints: [{ transport: a.transport, label: "a" }] });
    const second = open({ endpoints: [{ transport: b.transport, label: "b" }] });
    await first.value.probe();
    await second.value.probe();
    expect(await first.request({ method: "eth_call", params: [TX] })).toBe("0xa");
    expect(await second.request({ method: "eth_call", params: [TX] })).toBe("0xb");
    expect(await first.request({ method: "eth_call", params: [TX] })).toBe("0xa");
  });

  test("off by default: cacheStats is zero and every read goes upstream", async () => {
    const a = node("a", { value: 100 });
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], cache: false });
    await client.value.probe();
    await client.request({ method: "eth_call", params: [TX] });
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call")).toBe(2);
    expect(client.value.cacheStats()).toEqual({ hits: 0, misses: 0, refreshes: 0, entries: 0, bytes: 0, hotKeys: 0 });
  });

  test("without head tracking only reads by hash are cached", async () => {
    const a = node("a", { value: 100 }, (method) =>
      method === "eth_getBlockByHash" ? { number: "0x1", hash: HASH } : "0x1",
    );
    const client = open({ endpoints: [{ transport: a.transport, label: "a" }], headLag: false, pinLatest: false });
    await client.request({ method: "eth_call", params: [TX] });
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call")).toBe(2);
    await client.request({ method: "eth_getBlockByHash", params: [HASH, false] });
    await client.request({ method: "eth_getBlockByHash", params: [HASH, false] });
    expect(a.count("eth_getBlockByHash")).toBe(1);
  });
});
