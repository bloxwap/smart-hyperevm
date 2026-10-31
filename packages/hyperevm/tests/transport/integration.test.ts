import { describe, expect, test } from "bun:test";
import {
  createPublicClient,
  createTransport,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { hyperEvm } from "viem/chains";

import { hyperevm, type HyperevmEvent } from "../../src/transport/mod.ts";

/**
 * How the fixes compose: chain verification, the breaker, head trust, labels, and sharing.
 * Each module has its own tests. These cover the paths where two of them meet.
 */

const A = "https://a.example.test/evm";
const B = "https://b.example.test/evm";
const C = "https://c.example.test/evm";

/** viem `fetchFn` that answers every call with `status`, and records the method. */
function failingFetch(status: number, methods: string[], headers?: Record<string, string>) {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    methods.push(body.method);
    return new Response("rate limited", { status, headers });
  };
}

interface MockEndpoint {
  transport: Transport;
  calls: string[];
}

function mockEndpoint(name: string, handler: (method: string) => unknown): MockEndpoint {
  const calls: string[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        calls.push(method);
        return handler(method);
      }) as EIP1193RequestFn,
    });
  return { transport, calls };
}

describe("chain verification and the breaker", () => {
  test("a 429 storm on the chain check is ejected and costs one request per call", async () => {
    const methods: string[] = [];
    const events: HyperevmEvent[] = [];
    const client = hyperevm({
      endpoints: [A, B, C],
      fetchFn: failingFetch(429, methods),
      headLag: false,
      routing: "best",
      onEvent: (event) => events.push(event),
    })({ timeout: 1_000 });
    const perCall: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const before = methods.length;
      await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
      perCall.push(methods.length - before);
    }
    expect(methods.every((method) => method === "eth_chainId")).toBe(true);
    expect(methods.length).toBeLessThan(30);
    expect(perCall.slice(-5)).toEqual([1, 1, 1, 1, 1]);
    const ejected = events.filter((event) => event.type === "eject").map((event) => event.endpoint);
    expect(ejected.sort()).toEqual(["https://a.example.test", "https://b.example.test", "https://c.example.test"]);
  });

  test("Retry-After on the chain check ejects the endpoint", async () => {
    const methods: string[] = [];
    const events: HyperevmEvent[] = [];
    const good = mockEndpoint("good", (method) => (method === "eth_chainId" ? "0x3e7" : "0x1"));
    const client = hyperevm({
      endpoints: [A, { transport: good.transport, label: "good" }],
      fetchFn: failingFetch(429, methods, { "retry-after": "30" }),
      headLag: false,
      routing: "best",
      onEvent: (event) => events.push(event),
    })({ timeout: 1_000 });
    for (let index = 0; index < 5; index += 1)
      expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(methods).toEqual(["eth_chainId"]);
    expect(events.find((event) => event.type === "eject")).toMatchObject({
      endpoint: "https://a.example.test",
      cooldownMs: 30_000,
    });
  });
});

describe("availability", () => {
  test("a quarantined, a lying, and two ejected endpoints still leave the liar to serve", async () => {
    const testnet = mockEndpoint("testnet", (method) => (method === "eth_chainId" ? "0x3e6" : "0x1"));
    const liar = mockEndpoint("liar", (method) => {
      if (method === "eth_chainId") return "0x3e7";
      return method === "eth_blockNumber" ? "0xffffffff" : "0xliar";
    });
    const broken = (name: string): MockEndpoint =>
      mockEndpoint(name, (method) => {
        if (method === "eth_chainId") return "0x3e7";
        if (method === "eth_blockNumber") return "0x1000";
        throw new Error("socket hang up");
      });
    const first = broken("first");
    const second = broken("second");
    const client = hyperevm({
      endpoints: [testnet.transport, liar.transport, first.transport, second.transport],
      headLag: { probeInterval: false },
      routing: "best",
    })({ timeout: 1_000 });
    await client.value?.probe();
    const lag = (client.value?.snapshot() ?? []).map((endpoint) => [endpoint.quarantined, endpoint.lag]);
    expect(lag).toEqual([
      [true, null],
      [false, null],
      [false, 0],
      [false, 0],
    ]);
    // Each call fails on both honest endpoints, then lands on the liar. Three calls eject both.
    for (let index = 0; index < 3; index += 1) {
      expect(await client.request({ method: "eth_call", params: [] })).toBe("0xliar");
    }
    const firstCalls = first.calls.length;
    const secondCalls = second.calls.length;
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xliar");
    expect(first.calls).toHaveLength(firstCalls);
    expect(second.calls).toHaveLength(secondCalls);
    expect(testnet.calls).toEqual(["eth_chainId"]);
  });

  test("when every endpoint is ejected, each call still tries the best one", async () => {
    let healthy = false;
    const node = mockEndpoint("node", (method) => {
      if (method === "eth_chainId") return "0x3e7";
      if (!healthy) throw new Error("socket hang up");
      return "0x1";
    });
    const client = hyperevm({ endpoints: [node.transport], headLag: false })({ timeout: 1_000 });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    healthy = true;
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
  });
});

describe("shared instances", () => {
  test("clients on one factory share chain verdicts and breaker state", async () => {
    const node = mockEndpoint("node", (method) => (method === "eth_chainId" ? "0x3e7" : "0x1"));
    const transport = hyperevm({ endpoints: [node.transport], headLag: { probeInterval: false } });
    for (let index = 0; index < 5; index += 1) {
      await createPublicClient({ chain: hyperEvm, transport }).request({ method: "eth_blockNumber" });
    }
    expect(node.calls.filter((method) => method === "eth_chainId")).toHaveLength(1);
    const client = createPublicClient({ chain: hyperEvm, transport });
    client.transport.close();
    await createPublicClient({ chain: hyperEvm, transport }).request({ method: "eth_blockNumber" });
    // A fresh instance after close() verifies the chain again.
    expect(node.calls.filter((method) => method === "eth_chainId")).toHaveLength(2);
  });
});
