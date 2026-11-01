import { describe, expect, test } from "bun:test";
import {
  createPublicClient,
  createTransport,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { hyperEvm } from "viem/chains";

import { AllEndpointsFailedError, TransportClosedError } from "../../src/_errors.ts";
import { smartHyperevm, type HyperevmTransportOptions } from "../../src/transport/mod.ts";
import { BASELINE } from "./_baseline.ts";

const URLS = ["https://a.example.test/evm", "https://b.example.test/evm", "https://c.example.test/evm"] as const;

interface MockFetch {
  fetchFn: NonNullable<HyperevmTransportOptions["fetchFn"]>;
  methods: string[];
  count: (method: string) => number;
}

/** A fetch for viem `http()` that answers every JSON-RPC call and records the methods. */
function mockFetch(): MockFetch {
  const methods: string[] = [];
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const parsed = JSON.parse(String(init?.body));
    const items: { id: number; method: string }[] = Array.isArray(parsed) ? parsed : [parsed];
    const results = items.map((item) => {
      methods.push(item.method);
      return { jsonrpc: "2.0", id: item.id, result: item.method === "eth_chainId" ? "0x3e7" : "0x10" };
    });
    return new Response(JSON.stringify(Array.isArray(parsed) ? results : results[0]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, methods, count: (method) => methods.filter((item) => item === method).length };
}

function factory(fetch: MockFetch, headLag: HyperevmTransportOptions["headLag"]) {
  return smartHyperevm({
    ...BASELINE,
    endpoints: [...URLS],
    fetchFn: fetch.fetchFn,
    headLag,
    hedge: false,
    routing: "best",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An abort signal that tracks how many abort listeners are still attached. */
function trackedSignal(): { signal: AbortSignal; active: () => number } {
  const signal = new AbortController().signal;
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
    if (type === "abort") live.add(listener);
    add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
    if (type === "abort") live.delete(listener);
    remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];
  return { signal, active: () => live.size };
}

function failing(name: string): Transport {
  return () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        if (method === "eth_chainId") return "0x3e7";
        throw new Error("socket hang up");
      }) as EIP1193RequestFn,
    });
}

describe("smartHyperevm transport lifecycle", () => {
  test("50 clients on one factory share one scoreboard and one probe timer", async () => {
    const fetch = mockFetch();
    const transport = factory(fetch, { probeInterval: 20 });
    const clients = Array.from({ length: 50 }, () => createPublicClient({ chain: hyperEvm, transport }));
    await Promise.all(clients.map((client) => client.request({ method: "eth_chainId" })));
    await sleep(110);
    const probes = fetch.count("eth_blockNumber");
    // One timer ticks about five times in 110ms, for three endpoints. Fifty timers sent 750.
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThanOrEqual(URLS.length * 8);
    const first = clients[0]?.transport;
    const last = clients[49]?.transport;
    expect(first?.snapshot).toBe(last?.snapshot ?? (() => []));
    first?.close();
  });

  test("instantiations with different timeout, retryCount, or chain stay separate", () => {
    const fetch = mockFetch();
    const transport = factory(fetch, false);
    const base = transport({ chain: hyperEvm, timeout: 1_000 });
    expect(transport({ chain: hyperEvm, timeout: 1_000 }).value).toBe(base.value);
    expect(transport({ chain: hyperEvm, timeout: 2_000 }).value).not.toBe(base.value);
    expect(transport({ chain: hyperEvm, timeout: 1_000, retryCount: 5 }).value).not.toBe(base.value);
    expect(transport({ timeout: 1_000 }).value).not.toBe(base.value);
  });

  test("does not probe before the first request", async () => {
    const fetch = mockFetch();
    const transport = factory(fetch, { probeInterval: 10 });
    const clients = Array.from({ length: 5 }, () => createPublicClient({ chain: hyperEvm, transport }));
    await sleep(60);
    expect(fetch.methods).toHaveLength(0);
    await clients[0]?.request({ method: "eth_chainId" });
    await sleep(60);
    expect(fetch.count("eth_blockNumber")).toBeGreaterThan(0);
    clients[0]?.transport.close();
  });

  test("stops the probe timer when idle and restarts it on the next request", async () => {
    const fetch = mockFetch();
    const client = createPublicClient({
      chain: hyperEvm,
      transport: factory(fetch, { probeInterval: 10, probeIdleTimeout: 40 }),
    });
    await client.request({ method: "eth_chainId" });
    await sleep(150);
    const idle = fetch.count("eth_blockNumber");
    expect(idle).toBeGreaterThan(0);
    await sleep(80);
    expect(fetch.count("eth_blockNumber")).toBe(idle);
    await client.request({ method: "eth_chainId" });
    await sleep(60);
    expect(fetch.count("eth_blockNumber")).toBeGreaterThan(idle);
    client.transport.close();
  });

  test("probeInterval false never starts the timer", async () => {
    const fetch = mockFetch();
    const client = createPublicClient({ chain: hyperEvm, transport: factory(fetch, { probeInterval: false }) });
    await client.request({ method: "eth_chainId" });
    await sleep(40);
    expect(fetch.count("eth_blockNumber")).toBe(0);
  });

  test("close() stops probes, rejects later requests on every sharing client, and is idempotent", async () => {
    const fetch = mockFetch();
    const transport = factory(fetch, { probeInterval: 10 });
    const first = createPublicClient({ chain: hyperEvm, transport });
    const second = createPublicClient({ chain: hyperEvm, transport });
    expect(await first.request({ method: "eth_chainId" })).toBe("0x3e7");
    first.transport.close();
    first.transport.close();
    const stopped = fetch.methods.length;
    await sleep(40);
    expect(fetch.methods).toHaveLength(stopped);
    await expect(first.request({ method: "eth_chainId" })).rejects.toBeInstanceOf(TransportClosedError);
    await expect(second.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(TransportClosedError);
    await first.transport.probe();
    expect(fetch.methods).toHaveLength(stopped);

    const fresh = createPublicClient({ chain: hyperEvm, transport });
    expect(await fresh.request({ method: "eth_chainId" })).toBe("0x3e7");
    fresh.transport.close();
  });

  test("close() lets calls already in flight finish", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const node: Transport = () =>
      createTransport({
        key: "node",
        name: "node",
        type: "test",
        retryCount: 0,
        request: (async ({ method }: EIP1193Parameters) => {
          if (method === "eth_chainId") return "0x3e7";
          await gate;
          return "0x10";
        }) as EIP1193RequestFn,
      });
    const client = createPublicClient({
      chain: hyperEvm,
      transport: smartHyperevm({ ...BASELINE, endpoints: [node], headLag: false }),
    });
    const pending = client.request({ method: "eth_blockNumber" });
    await sleep(10);
    client.transport.close();
    release?.();
    expect(await pending).toBe("0x10");
    await expect(client.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(TransportClosedError);
  });

  test("attempts and retry waits do not leave listeners on a long-lived signal", async () => {
    const tracked = trackedSignal();
    const client = smartHyperevm({
      ...BASELINE,
      endpoints: [failing("first"), failing("second")],
      headLag: false,
      hedge: false,
      routing: "best",
      retryCount: 1,
      retryDelay: 1,
      // Every call fails, so the breaker would eject both endpoints and skip the waits this test counts.
      breaker: false,
    })({ timeout: 1_000 });
    for (let index = 0; index < 10; index += 1) {
      await expect(
        client.request({ method: "eth_call", params: [] }, { signal: tracked.signal }),
      ).rejects.toBeInstanceOf(AllEndpointsFailedError);
      expect(await client.request({ method: "eth_chainId" }, { signal: tracked.signal })).toBe("0x3e7");
    }
    expect(tracked.active()).toBe(0);
  });

  test("viem http endpoints do not leave listeners on a long-lived signal", async () => {
    const tracked = trackedSignal();
    const fetch = mockFetch();
    const client = factory(fetch, false)({ chain: hyperEvm, timeout: 1_000 });
    for (let index = 0; index < 20; index += 1) {
      await client.request({ method: "eth_blockNumber" }, { signal: tracked.signal });
    }
    expect(fetch.count("eth_blockNumber")).toBe(20);
    expect(tracked.active()).toBe(0);
  });
});
