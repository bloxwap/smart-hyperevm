import { describe, expect, test } from "bun:test";
import {
  createPublicClient,
  createTransport,
  http,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { hyperEvm } from "viem/chains";

import { AllEndpointsFailedError } from "../../src/_errors.ts";
import { hyperevm, type HyperevmTransportOptions } from "../../src/transport/mod.ts";

interface MockEndpoint {
  transport: Transport;
  calls: { method: string }[];
}

function mockEndpoint(name: string, handler: (method: string) => unknown | Promise<unknown>): MockEndpoint {
  const calls: { method: string }[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        calls.push({ method });
        return handler(method);
      }) as EIP1193RequestFn,
    });
  return { transport, calls };
}

function open(options: HyperevmTransportOptions) {
  return hyperevm({
    headLag: false,
    routing: "best",
    retryCount: 2,
    hedge: false,
    // These mocks answer every method alike. Chain checks have their own tests.
    verifyChainId: false,
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
}

function hang(method: string): Promise<never> {
  void method;
  return new Promise(() => {});
}

describe("hyperevm transport", () => {
  test("createPublicClient can read the chain id through the transport", async () => {
    const endpoint = mockEndpoint("only", (method) => (method === "eth_chainId" ? "0x3e7" : "0x1"));
    const client = createPublicClient({
      chain: hyperEvm,
      transport: hyperevm({
        endpoints: [endpoint.transport],
        headLag: false,
        routing: "best",
      }),
    });
    expect(await client.getChainId()).toBe(999);
    expect(endpoint.calls.map((call) => call.method)).toContain("eth_chainId");
  });

  test("fails over a dead endpoint and then prefers the one that answered", async () => {
    const dead = mockEndpoint("dead", () => {
      throw new Error("socket hang up");
    });
    const live = mockEndpoint("live", () => "0x1");
    const client = open({ endpoints: [dead.transport, live.transport] });
    expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    expect(dead.calls).toHaveLength(1);
    expect(live.calls).toHaveLength(2);
  });

  test("does not retry a non-idempotent method", async () => {
    const first = mockEndpoint("first", () => {
      throw new Error("timeout talking to the node");
    });
    const second = mockEndpoint("second", () => "0xhash");
    const client = open({ endpoints: [first.transport, second.transport] });
    await expect(client.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow(/timeout talking/);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  test("does not fail over an execution revert or invalid params", async () => {
    const revert = mockEndpoint("revert", () => {
      throw Object.assign(new Error("execution reverted: nope"), { code: 3 });
    });
    const other = mockEndpoint("other", () => "0x1");
    const client = open({ endpoints: [revert.transport, other.transport] });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow(/execution reverted/);
    expect(other.calls).toHaveLength(0);

    const invalid = mockEndpoint("invalid", () => {
      throw Object.assign(new Error("missing field"), { code: -32602 });
    });
    const backup = mockEndpoint("backup", () => "0x1");
    const second = open({ endpoints: [invalid.transport, backup.transport] });
    await expect(second.request({ method: "eth_call", params: [] })).rejects.toThrow();
    expect(backup.calls).toHaveLength(0);
  });

  test("times out a hung endpoint and uses the next one", async () => {
    const slow = mockEndpoint("slow", hang);
    const fast = mockEndpoint("fast", () => "0x55");
    const client = open({
      endpoints: [slow.transport, fast.transport],
      timeout: 40,
      retryCount: 1,
    });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x55");
    expect(fast.calls).toHaveLength(1);
  });

  test("retryCount 0 does not fail over", async () => {
    const first = mockEndpoint("first", () => {
      throw new Error("down");
    });
    const second = mockEndpoint("second", () => "0x1");
    const client = open({ endpoints: [first.transport, second.transport], retryCount: 0 });
    await expect(client.request({ method: "eth_chainId" })).rejects.toThrow(/down/);
    expect(second.calls).toHaveLength(0);
  });

  test("reports every endpoint when all of them fail", async () => {
    const first = mockEndpoint("first", () => {
      throw new Error("one");
    });
    const second = mockEndpoint("second", () => {
      throw new Error("two");
    });
    const client = open({ endpoints: [first.transport, second.transport], retryCount: 1 });
    await expect(client.request({ method: "eth_chainId" })).rejects.toBeInstanceOf(AllEndpointsFailedError);
  });

  test("routes later calls to the endpoint with the better latency", async () => {
    let nowMs = 0;
    const slow = mockEndpoint("slow", () => {
      // Slower than the cold prior, so the next call tries the other endpoint.
      nowMs += 800;
      return "0x1";
    });
    const fast = mockEndpoint("fast", () => {
      nowMs += 15;
      return "0x1";
    });
    const client = open({
      endpoints: [slow.transport, fast.transport],
      now: () => nowMs,
      score: { confidenceSamples: 1 },
    });
    await client.request({ method: "eth_chainId" });
    await client.request({ method: "eth_chainId" });
    slow.calls.length = 0;
    fast.calls.length = 0;
    for (let index = 0; index < 4; index += 1) await client.request({ method: "eth_chainId" });
    expect(fast.calls.length).toBeGreaterThan(slow.calls.length);
  });

  test("scores eth_call and eth_getLogs separately", async () => {
    let nowMs = 0;
    const callFast = mockEndpoint("call-fast", (method) => {
      nowMs += method === "eth_getLogs" ? 2_000 : 40;
      return method === "eth_getLogs" ? [] : "0x1";
    });
    const logsFast = mockEndpoint("logs-fast", (method) => {
      nowMs += method === "eth_getLogs" ? 30 : 400;
      return method === "eth_getLogs" ? [] : "0x1";
    });
    const client = open({
      endpoints: [callFast.transport, logsFast.transport],
      now: () => nowMs,
      perMethod: true,
      score: { confidenceSamples: 1, methodBlendSamples: 1 },
    });
    await Promise.all([client.request({ method: "eth_call" }), client.request({ method: "eth_call" })]);
    await client.request({ method: "eth_getLogs" });
    await client.request({ method: "eth_getLogs" });
    callFast.calls.length = 0;
    logsFast.calls.length = 0;
    for (let index = 0; index < 3; index += 1) await client.request({ method: "eth_call" });
    for (let index = 0; index < 3; index += 1) await client.request({ method: "eth_getLogs" });
    const callFastCalls = callFast.calls.filter((call) => call.method === "eth_call").length;
    const logsFastCalls = logsFast.calls.filter((call) => call.method === "eth_getLogs").length;
    expect(callFastCalls).toBe(3);
    expect(logsFastCalls).toBe(3);
  });

  test("deprioritizes an endpoint behind the best head", async () => {
    let nowMs = 1_000;
    const behind = mockEndpoint("behind", (method) => {
      nowMs += 5;
      return method === "eth_blockNumber" ? "0x64" : "0x1";
    });
    const ahead = mockEndpoint("ahead", (method) => {
      nowMs += 5;
      return method === "eth_blockNumber" ? "0x6e" : "0x1";
    });
    const client = open({
      endpoints: [behind.transport, ahead.transport],
      now: () => nowMs,
      headLag: { maxLag: 0, probeInterval: false, staleMs: 60_000 },
      score: { confidenceSamples: 1 },
    });
    await Promise.all([client.request({ method: "eth_blockNumber" }), client.request({ method: "eth_blockNumber" })]);
    behind.calls.length = 0;
    ahead.calls.length = 0;
    expect(await client.request({ method: "eth_call" })).toBe("0x1");
    expect(ahead.calls.map((call) => call.method)).toContain("eth_call");
    expect(behind.calls.map((call) => call.method)).not.toContain("eth_call");
    const snapshot = client.value?.snapshot() ?? [];
    const behindSnap = snapshot.find((item) => item.url === "transport:0");
    const aheadSnap = snapshot.find((item) => item.url === "transport:1");
    expect(behindSnap?.head).toBe(100);
    expect(aheadSnap?.head).toBe(110);
    expect(behindSnap?.lag).toBe(10);
  });

  test("hedges a slow idempotent read and does not hedge a send", async () => {
    const slow = mockEndpoint("slow", async (method) => {
      if (method === "eth_sendRawTransaction") return "0xslow";
      await new Promise((resolve) => setTimeout(resolve, 180));
      return "slow";
    });
    const fast = mockEndpoint("fast", () => "fast");
    const client = open({
      endpoints: [slow.transport, fast.transport],
      hedge: { minDelay: 30, multiplier: 0 },
      timeout: 1_000,
    });
    expect(await client.request({ method: "eth_call" })).toBe("fast");
    expect(fast.calls.length).toBeGreaterThan(0);

    const sendSlow = mockEndpoint("send-slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return "0xsended";
    });
    const sendFast = mockEndpoint("send-fast", () => "0xother");
    const sender = open({
      endpoints: [sendSlow.transport, sendFast.transport],
      hedge: { minDelay: 30, multiplier: 0 },
      timeout: 1_000,
    });
    expect(await sender.request({ method: "eth_sendRawTransaction", params: ["0xabc"] })).toBe("0xsended");
    expect(sendFast.calls).toHaveLength(0);
  });

  test("batches URL endpoints through viem http", async () => {
    const bodies: unknown[] = [];
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsed = JSON.parse(String(init?.body));
      bodies.push(parsed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const results = items.map((item: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: item.id,
        result: item.method === "eth_chainId" ? "0x3e7" : "0x10",
      }));
      const payload = Array.isArray(parsed) ? results : results[0];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = open({
      endpoints: ["https://rpc.example.test/evm"],
      batch: { batchSize: 20, wait: 0 },
      fetchFn,
      timeout: 1_000,
    });
    const [chainId, block] = await Promise.all([
      client.request({ method: "eth_chainId" }),
      client.request({ method: "eth_blockNumber" }),
    ]);
    expect(chainId).toBe("0x3e7");
    expect(block).toBe("0x10");
    expect(bodies).toHaveLength(1);
    expect(Array.isArray(bodies[0])).toBe(true);
  });

  test("does not expose a merged subscribe helper", () => {
    const endpoint = mockEndpoint("only", () => "0x1");
    const client = open({ endpoints: [endpoint.transport] });
    expect(typeof client.value?.snapshot).toBe("function");
    expect(client.value && "subscribe" in client.value).toBe(false);
    // The child http transport is what batches. This assertion keeps the import honest.
    expect(typeof http).toBe("function");
  });

  test("onEvent observes failover", async () => {
    const events: string[] = [];
    const dead = mockEndpoint("dead", () => {
      throw new Error("nope");
    });
    const live = mockEndpoint("live", () => "0x1");
    const client = open({
      endpoints: [dead.transport, live.transport],
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    await client.request({ method: "eth_chainId" });
    expect(events).toContain("failover");
    expect(events).toContain("success");
  });
});

describe("head trust through viem http", () => {
  type Answer = (method: string, params: unknown) => unknown;

  function rpc(answers: Record<string, Answer>) {
    const calls: { host: string; method: string; params: unknown }[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
      calls.push({ host, method: body.method, params: body.params });
      const answer = answers[host];
      if (!answer) throw new Error(`unexpected host ${host}`);
      const result = body.method === "eth_chainId" ? "0x3e7" : answer(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { calls, fetchFn };
  }

  function block(number: string): Record<string, unknown> {
    const zero = (bytes: number): string => `0x${"00".repeat(bytes)}`;
    return {
      number,
      hash: `0x${"ab".repeat(32)}`,
      parentHash: zero(32),
      timestamp: "0x1",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      baseFeePerGas: "0x1",
      difficulty: "0x0",
      extraData: "0x",
      logsBloom: zero(256),
      miner: zero(20),
      mixHash: zero(32),
      nonce: "0x0000000000000000",
      receiptsRoot: zero(32),
      sha3Uncles: zero(32),
      size: "0x1",
      stateRoot: zero(32),
      transactionsRoot: zero(32),
      transactions: [],
      uncles: [],
    };
  }

  const honest =
    (head: { value: number }): Answer =>
    (method, params) => {
      const latest = `0x${head.value.toString(16)}`;
      if (method === "eth_blockNumber") return latest;
      if (method === "eth_getBlockByNumber") {
        const tag = Array.isArray(params) ? params[0] : undefined;
        return block(tag === "latest" ? latest : String(tag));
      }
      if (method === "eth_getBlockByHash") return block("0x10");
      return "0x";
    };

  const liar: Answer = (method) => (method === "eth_blockNumber" ? "0xffffffff" : "0x");

  function lcg(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    };
  }

  function reader(fetchFn: HyperevmTransportOptions["fetchFn"], routing: "best" | "p2c") {
    return createPublicClient({
      chain: hyperEvm,
      transport: hyperevm({
        endpoints: ["https://a.example.test/evm", "https://b.example.test/evm", "https://c.example.test/evm"],
        fetchFn,
        routing,
        random: lcg(7),
        hedge: false,
        headLag: { probeInterval: false },
      }),
    });
  }

  const ethCall = { method: "eth_call", params: [{ to: `0x${"00".repeat(19)}01`, data: "0x" }, "latest"] } as const;

  test("an endpoint reporting 0xffffffff gets no traffic under best", async () => {
    const head = { value: 1_000 };
    const mock = rpc({ "a.example.test": honest(head), "b.example.test": honest(head), "c.example.test": liar });
    const client = reader(mock.fetchFn, "best");
    await client.transport.probe();
    mock.calls.length = 0;
    for (let index = 0; index < 200; index += 1) await client.request(ethCall);
    expect(mock.calls.filter((call) => call.host === "c.example.test")).toHaveLength(0);
    expect(client.transport.snapshot().map((item) => item.lag)).toEqual([0, 0, null]);
  });

  test("an endpoint reporting 0xffffffff gets at most its fair share under p2c", async () => {
    const head = { value: 1_000 };
    const mock = rpc({ "a.example.test": honest(head), "b.example.test": honest(head), "c.example.test": liar });
    const client = reader(mock.fetchFn, "p2c");
    await client.transport.probe();
    mock.calls.length = 0;
    for (let index = 0; index < 200; index += 1) await client.request(ethCall);
    expect(mock.calls.filter((call) => call.host === "c.example.test").length).toBeLessThan(20);
  });

  test("a historical block does not move a healthy endpoint's head", async () => {
    const head = { value: 0x1000 };
    const mock = rpc({
      "a.example.test": honest(head),
      "b.example.test": honest(head),
      "c.example.test": honest(head),
    });
    const client = reader(mock.fetchFn, "best");
    await client.transport.probe();
    await client.getBlock({ blockNumber: 16n });
    await client.getBlock({ blockHash: `0x${"ab".repeat(32)}` });
    expect(mock.calls.filter((call) => call.method.startsWith("eth_getBlockBy"))).toHaveLength(2);
    expect(client.transport.snapshot().map((item) => [item.head, item.lag])).toEqual([
      [0x1000, 0],
      [0x1000, 0],
      [0x1000, 0],
    ]);
  });

  test("a legitimately advancing chain still updates heads", async () => {
    const head = { value: 0x1000 };
    const slow = { value: 0x1000 };
    const mock = rpc({
      "a.example.test": honest(head),
      "b.example.test": honest(head),
      "c.example.test": honest(slow),
    });
    const client = reader(mock.fetchFn, "best");
    await client.transport.probe();
    head.value = 0x1008;
    await client.transport.probe();
    expect(client.transport.snapshot().map((item) => [item.head, item.lag])).toEqual([
      [0x1008, 0],
      [0x1008, 0],
      [0x1000, 8],
    ]);
    head.value = 0x1009;
    expect((await client.getBlock()).number).toBe(0x1009n);
    const rows = client.transport.snapshot();
    expect(Math.max(...rows.map((item) => item.head ?? 0))).toBe(0x1009);
    expect(rows[2]?.lag).toBe(9);
  });
});
