import { describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { Coalescer, coalesceKey, isCoalescableMethod } from "../../src/transport/_coalesce.ts";
import { hyperevm, type HyperevmEvent, type HyperevmTransportOptions } from "../../src/transport/mod.ts";
import { BASELINE } from "./_baseline.ts";

interface Call {
  method: string;
  params: unknown;
  signal: AbortSignal | undefined;
}

interface MockEndpoint {
  transport: Transport;
  calls: Call[];
  /** Calls other than `eth_chainId`. */
  reads: () => Call[];
}

function mockEndpoint(
  name: string,
  handler: (method: string, signal: AbortSignal | undefined) => unknown | Promise<unknown>,
): MockEndpoint {
  const calls: Call[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method, params }: EIP1193Parameters, options?: { signal?: AbortSignal }) => {
        calls.push({ method, params, signal: options?.signal });
        return handler(method, options?.signal);
      }) as EIP1193RequestFn,
    });
  return { transport, calls, reads: () => calls.filter((call) => call.method !== "eth_chainId") };
}

/** A promise settled from outside, for holding an upstream answer until the test releases it. */
function deferred<T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Rejects when `signal` aborts, as a real `fetch` would. */
function untilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
      once: true,
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let queued microtasks and zero-delay work run. */
function flush(): Promise<void> {
  return sleep(0);
}

function open(options: HyperevmTransportOptions) {
  return hyperevm({ ...BASELINE, headLag: false, routing: "best", hedge: false, verifyChainId: false, ...options })({
    timeout: options.timeout ?? 1_000,
  });
}

function coalesced(events: HyperevmEvent[]): number {
  return events.filter((event) => event.type === "coalesce").length;
}

describe("coalesceKey", () => {
  test("sorts object keys at every depth", () => {
    const left = coalesceKey("eth_call", [{ to: "0x1", data: "0x2", nested: { b: 1, a: 2 } }, "latest"]);
    const right = coalesceKey("eth_call", [{ nested: { a: 2, b: 1 }, data: "0x2", to: "0x1" }, "latest"]);
    expect(left).toBe(right);
  });

  test("keeps method, order, and types apart", () => {
    expect(coalesceKey("eth_call", ["0x1"])).not.toBe(coalesceKey("eth_estimateGas", ["0x1"]));
    expect(coalesceKey("m", ["a", "b"])).not.toBe(coalesceKey("m", ["b", "a"]));
    expect(coalesceKey("m", [1n])).not.toBe(coalesceKey("m", ["1"]));
    expect(coalesceKey("m", [1n])).not.toBe(coalesceKey("m", [1]));
    expect(coalesceKey("m", [Number.NaN])).not.toBe(coalesceKey("m", [null]));
    expect(coalesceKey("m", undefined)).not.toBe(coalesceKey("m", []));
    expect(coalesceKey("m", [10n ** 30n])).toBe(`m:[${10n ** 30n}n]`);
  });

  test("returns undefined for params that cannot be serialized", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(coalesceKey("eth_call", [cycle])).toBeUndefined();
    // A shared, acyclic reference is fine.
    const shared = { a: 1 };
    expect(coalesceKey("eth_call", [shared, shared])).toBe('eth_call:[{"a":1},{"a":1}]');
  });
});

describe("isCoalescableMethod", () => {
  test("only idempotent reads that are not subscriptions or filters", () => {
    expect(isCoalescableMethod("eth_call", true)).toBe(true);
    expect(isCoalescableMethod("eth_getLogs", true)).toBe(true);
    expect(isCoalescableMethod("eth_call", false)).toBe(false);
    for (const method of ["eth_subscribe", "eth_unsubscribe", "eth_getFilterLogs", "eth_uninstallFilter"]) {
      expect(isCoalescableMethod(method, true)).toBe(false);
    }
  });
});

describe("in-flight coalescing", () => {
  test("is on by default: identical concurrent reads share one request and its result", async () => {
    const gate = deferred();
    const node = mockEndpoint("node", () => gate.promise);
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [node.transport], onEvent: (event) => events.push(event) });
    const pending = Array.from({ length: 5 }, () =>
      client.request({ method: "eth_call", params: [{ to: "0x1", data: "0x" }, "latest"] }),
    );
    await flush();
    gate.resolve("0xshared");
    expect(await Promise.all(pending)).toEqual(Array(5).fill("0xshared"));
    expect(node.reads()).toHaveLength(1);
    expect(coalesced(events)).toBe(4);
    expect(events.filter((event) => event.type === "request")).toHaveLength(1);
  });

  test("keeps nothing after the request settles", async () => {
    const node = mockEndpoint("node", () => `0x${node.reads().length}`);
    const client = open({ endpoints: [node.transport] });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x1");
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x2");
    expect(node.reads()).toHaveLength(2);
  });

  test("different params do not share", async () => {
    const node = mockEndpoint("node", async () => {
      await sleep(5);
      return "0x1";
    });
    const client = open({ endpoints: [node.transport] });
    await Promise.all([
      client.request({ method: "eth_getBalance", params: ["0xa", "latest"] }),
      client.request({ method: "eth_getBalance", params: ["0xb", "latest"] }),
      client.request({ method: "eth_getBalance", params: ["0xa", "0x10"] }),
    ]);
    expect(node.reads()).toHaveLength(3);
  });

  test("coalesce: false sends every call", async () => {
    const node = mockEndpoint("node", async () => {
      await sleep(5);
      return "0x1";
    });
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [node.transport], coalesce: false, onEvent: (event) => events.push(event) });
    await Promise.all(Array.from({ length: 4 }, () => client.request({ method: "eth_blockNumber" })));
    expect(node.reads()).toHaveLength(4);
    expect(coalesced(events)).toBe(0);
  });

  test("never shares sends, non-idempotent methods, or filter polls", async () => {
    const node = mockEndpoint("node", async (method) => {
      await sleep(5);
      return method === "eth_getFilterChanges" ? [] : "0xhash";
    });
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [node.transport],
      nonIdempotentMethods: ["hl_spend"],
      onEvent: (event) => events.push(event),
    });
    const twice = (method: string, params: unknown[]): Promise<unknown>[] => [
      client.request({ method, params } as EIP1193Parameters),
      client.request({ method, params } as EIP1193Parameters),
    ];
    await Promise.all([
      ...twice("eth_sendRawTransaction", ["0x02f8"]),
      ...twice("eth_getFilterChanges", ["0x1"]),
      ...twice("eth_getFilterLogs", ["0x1"]),
      ...twice("hl_spend", []),
    ]);
    for (const method of ["eth_sendRawTransaction", "eth_getFilterChanges", "eth_getFilterLogs", "hl_spend"]) {
      expect(node.reads().filter((call) => call.method === method)).toHaveLength(2);
    }
    expect(coalesced(events)).toBe(0);
  });

  test("every caller gets the shared error", async () => {
    const node = mockEndpoint("node", async () => {
      await sleep(5);
      throw Object.assign(new Error("execution reverted"), { code: 3 });
    });
    const client = open({ endpoints: [node.transport] });
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, () =>
        client.request({ method: "eth_call", params: [{ to: "0x1" }, "latest"] }).catch((error: unknown) => error),
      ),
    );
    expect(outcomes[0]).toBeInstanceOf(Error);
    expect((outcomes[0] as Error).message).toMatch(/execution reverted/);
    expect(new Set(outcomes).size).toBe(1);
    expect(node.reads()).toHaveLength(1);
  });

  test("the shared request fails over like any call", async () => {
    const down = mockEndpoint("down", async () => {
      await sleep(5);
      throw new Error("socket hang up");
    });
    const up = mockEndpoint("up", () => "0xup");
    const client = open({ endpoints: [down.transport, up.transport] });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => client.request({ method: "eth_getBalance", params: ["0xa", "latest"] })),
    );
    expect(results).toEqual(Array(4).fill("0xup"));
    expect(down.reads()).toHaveLength(1);
    expect(up.reads()).toHaveLength(1);
  });

  test("a rate-limited endpoint gets one request for a burst, then the breaker keeps it out", async () => {
    const limited = mockEndpoint("limited", async () => {
      await sleep(5);
      throw Object.assign(new Error("rate limited"), { headers: new Headers({ "retry-after": "30" }) });
    });
    const backup = mockEndpoint("backup", () => "0xbackup");
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [limited.transport, backup.transport],
      onEvent: (event) => events.push(event),
    });
    const burst = Array.from({ length: 6 }, () => client.request({ method: "eth_call", params: [{ to: "0x1" }] }));
    expect(await Promise.all(burst)).toEqual(Array(6).fill("0xbackup"));
    expect(limited.reads()).toHaveLength(1);
    expect(events.some((event) => event.type === "eject" && event.endpoint === "transport:0")).toBe(true);
    expect(await client.request({ method: "eth_call", params: [{ to: "0x1" }] })).toBe("0xbackup");
    expect(limited.reads()).toHaveLength(1);
  });

  test("concurrent cold calls share one chain check, and a quarantined endpoint never serves", async () => {
    const wrong = mockEndpoint("wrong", async (method) => {
      await sleep(5);
      return method === "eth_chainId" ? "0x3e6" : "0xwrong";
    });
    const right = mockEndpoint("right", async (method) => {
      await sleep(5);
      return method === "eth_chainId" ? "0x3e7" : "0xright";
    });
    const client = open({ endpoints: [wrong.transport, right.transport], verifyChainId: true });
    const results = await Promise.all(Array.from({ length: 5 }, () => client.request({ method: "eth_blockNumber" })));
    expect(results).toEqual(Array(5).fill("0xright"));
    expect(wrong.reads()).toHaveLength(0);
    expect(right.reads()).toHaveLength(1);
    expect(right.calls.filter((call) => call.method === "eth_chainId")).toHaveLength(1);
  });

  test("separate shared instances do not share requests", async () => {
    const gate = deferred();
    const node = mockEndpoint("node", () => gate.promise);
    const factory = hyperevm({ ...BASELINE, endpoints: [node.transport], headLag: false, verifyChainId: false });
    const one = factory({ timeout: 1_000 });
    const two = factory({ timeout: 2_000 });
    const pending = [one.request({ method: "eth_blockNumber" }), two.request({ method: "eth_blockNumber" })];
    await flush();
    gate.resolve("0x1");
    await Promise.all(pending);
    expect(node.reads()).toHaveLength(2);
  });

  test("a call with no signal sends none, so viem's default batch key holds", async () => {
    const node = mockEndpoint("node", async () => {
      await sleep(5);
      return "0x1";
    });
    const client = open({ endpoints: [node.transport] });
    await Promise.all([client.request({ method: "eth_blockNumber" }), client.request({ method: "eth_blockNumber" })]);
    expect(node.reads()[0]?.signal).toBeUndefined();
  });
});

describe("coalescing and abort signals", () => {
  test("one caller aborting rejects only that caller", async () => {
    const gate = deferred();
    const node = mockEndpoint("node", (_method, signal) => Promise.race([gate.promise, untilAbort(signal)]));
    const client = open({ endpoints: [node.transport] });
    const first = new AbortController();
    const second = new AbortController();
    const a = client.request({ method: "eth_blockNumber" }, { signal: first.signal });
    const b = client.request({ method: "eth_blockNumber" }, { signal: second.signal });
    const c = client.request({ method: "eth_blockNumber" });
    await flush();
    const reason = new Error("caller a gave up");
    first.abort(reason);
    await expect(a).rejects.toBe(reason);
    expect(node.reads()[0]?.signal?.aborted).toBe(false);
    gate.resolve("0x7");
    expect(await b).toBe("0x7");
    expect(await c).toBe("0x7");
    expect(node.reads()).toHaveLength(1);
  });

  test("the shared request is cancelled once every caller has aborted, and a later caller starts fresh", async () => {
    const node = mockEndpoint("node", (_method, signal) =>
      node.reads().length === 1 ? untilAbort(signal) : Promise.resolve("0xfresh"),
    );
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [node.transport], onEvent: (event) => events.push(event) });
    const controllers = [new AbortController(), new AbortController()];
    const calls = controllers.map((controller) =>
      client
        .request({ method: "eth_call", params: [{ to: "0x1" }] }, { signal: controller.signal })
        .catch((error: unknown) => error),
    );
    await flush();
    const upstream = node.reads()[0]?.signal;
    controllers[0]?.abort();
    await flush();
    expect(upstream?.aborted).toBe(false);
    controllers[1]?.abort();
    const outcomes = await Promise.all(calls);
    expect(upstream?.aborted).toBe(true);
    for (const outcome of outcomes) expect((outcome as Error).name).toBe("AbortError");
    // The aborted request is gone, so this caller neither joins it nor inherits its signal.
    const later = new AbortController();
    expect(await client.request({ method: "eth_call", params: [{ to: "0x1" }] }, { signal: later.signal })).toBe(
      "0xfresh",
    );
    expect(node.reads()).toHaveLength(2);
    expect(node.reads()[1]?.signal?.aborted).toBe(false);
    // A caller abort is not an endpoint failure.
    expect(events.some((event) => event.type === "error" || event.type === "eject")).toBe(false);
  });

  test("a caller without a signal keeps the shared request alive", async () => {
    const gate = deferred();
    const node = mockEndpoint("node", (_method, signal) => Promise.race([gate.promise, untilAbort(signal)]));
    const client = open({ endpoints: [node.transport] });
    const controller = new AbortController();
    const signalled = client.request({ method: "eth_blockNumber" }, { signal: controller.signal });
    const plain = client.request({ method: "eth_blockNumber" });
    await flush();
    controller.abort();
    await expect(signalled).rejects.toThrow();
    expect(node.reads()[0]?.signal?.aborted).toBe(false);
    gate.resolve("0x9");
    expect(await plain).toBe("0x9");
    expect(node.reads()).toHaveLength(1);
  });

  test("an already-aborted caller does not join or disturb the shared request", async () => {
    const gate = deferred();
    const node = mockEndpoint("node", (_method, signal) => Promise.race([gate.promise, untilAbort(signal)]));
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [node.transport], onEvent: (event) => events.push(event) });
    const live = new AbortController();
    const running = client.request({ method: "eth_blockNumber" }, { signal: live.signal });
    await flush();
    const dead = new AbortController();
    dead.abort();
    await expect(client.request({ method: "eth_blockNumber" }, { signal: dead.signal })).rejects.toThrow();
    gate.resolve("0x3");
    expect(await running).toBe("0x3");
    expect(coalesced(events)).toBe(0);
  });

  test("abort listeners are removed when the shared request settles", async () => {
    const signal = new AbortController().signal;
    let live = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === "abort") live += 1;
      add(type, listener, options);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
      if (type === "abort") live -= 1;
      remove(type, listener, options);
    }) as AbortSignal["removeEventListener"];
    const node = mockEndpoint("node", async () => {
      await sleep(5);
      return "0x1";
    });
    const client = open({ endpoints: [node.transport] });
    await Promise.all(Array.from({ length: 3 }, () => client.request({ method: "eth_blockNumber" }, { signal })));
    expect(live).toBe(0);
  });
});

describe("coalescing alongside viem and failover", () => {
  test("calls that share one caller signal still share viem's HTTP batch", async () => {
    let posts = 0;
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      posts += 1;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string } | { id: number; method: string }[];
      const answer = (call: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: call.id,
        result: call.method === "eth_chainId" ? "0x3e7" : "0x1",
      });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), {
        headers: { "content-type": "application/json" },
      });
    };
    const client = open({ endpoints: ["https://rpc.example.com/evm"], batch: true, fetchFn });
    const controller = new AbortController();
    const addresses = ["0x01", "0x02", "0x03"].map((tail) => `0x${"0".repeat(38)}${tail.slice(2)}`);
    await Promise.all(
      addresses.map((address) =>
        client.request({ method: "eth_getBalance", params: [address, "latest"] }, { signal: controller.signal }),
      ),
    );
    expect(posts).toBe(1);
  });

  test("a joined caller waits out the shared request's failover instead of sending its own", async () => {
    const hung = mockEndpoint("hung", () => new Promise(() => {}));
    const quick = mockEndpoint("quick", async () => {
      await sleep(80);
      return "0x5";
    });
    const client = open({ endpoints: [hung.transport, quick.transport], retryCount: 2, timeout: 200 });
    const read = {
      method: "eth_getBalance",
      params: ["0x000000000000000000000000000000000000dead", "latest"],
    } as const;
    const first = client.request(read);
    await sleep(50);
    expect(await Promise.all([first, client.request(read)])).toEqual(["0x5", "0x5"]);
    expect([hung.reads().length, quick.reads().length]).toEqual([1, 1]);
  });
});

describe("Coalescer", () => {
  test("a joined caller stops waiting on a request that never settles and starts its own", async () => {
    const coalescer = new Coalescer(20);
    let runs = 0;
    const run = (): Promise<unknown> => {
      runs += 1;
      return runs === 1 ? new Promise(() => {}) : Promise.resolve("0xfresh");
    };
    let joins = 0;
    void coalescer.request("k", undefined, run, () => undefined);
    const joined = coalescer.request("k", undefined, run, () => {
      joins += 1;
    });
    expect(await Promise.race([joined, sleep(500).then(() => "hung")])).toBe("0xfresh");
    expect(runs).toBe(2);
    expect(joins).toBe(1);
  });

  test("a joined caller keeps waiting while the shared request reports progress", async () => {
    const coalescer = new Coalescer(30);
    let runs = 0;
    const run = (_signal: AbortSignal | undefined, progress: (waitMs?: number) => void): Promise<unknown> => {
      runs += 1;
      // A failover every 20ms, then an answer at 80ms: past the bound, but never 30ms without news.
      const ticks = [20, 40, 60].map((ms) => setTimeout(() => progress(), ms));
      return sleep(80).then(() => {
        for (const tick of ticks) clearTimeout(tick);
        return "0xshared";
      });
    };
    const first = coalescer.request("k", undefined, run, () => undefined);
    const joined = coalescer.request("k", undefined, run, () => undefined);
    expect(await Promise.all([first, joined])).toEqual(["0xshared", "0xshared"]);
    expect(runs).toBe(1);
  });

  test("entries leave the table when they settle", async () => {
    const coalescer = new Coalescer(1_000);
    const gate = deferred();
    const pending = [
      coalescer.request(
        "k",
        undefined,
        () => gate.promise,
        () => undefined,
      ),
      coalescer.request(
        "k",
        undefined,
        () => gate.promise,
        () => undefined,
      ),
    ];
    expect(coalescer.size).toBe(1);
    gate.resolve("0x1");
    await Promise.all(pending);
    expect(coalescer.size).toBe(0);
  });
});
