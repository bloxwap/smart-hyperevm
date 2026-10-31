import { afterEach, describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import {
  hyperevm,
  localStoragePersistence,
  type HyperevmEvent,
  type HyperevmTransportOptions,
  type HyperevmTransportValue,
  type ScorePersistence,
  type ScoreSnapshot,
} from "../../src/transport/mod.ts";

const START = 10_000_000;
const HOUR = 3_600_000;

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function clock(): Clock {
  let time = START;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

interface MockEndpoint {
  transport: Transport;
  calls: string[];
}

/** A viem transport that answers chain 999 and takes `latencyMs` of `time` for every other method. */
function mockEndpoint(
  name: string,
  time: Clock,
  latencyMs: number,
  handler: (method: string) => unknown = (method) => (method === "eth_chainId" ? "0x3e7" : "0x1"),
): MockEndpoint {
  const calls: string[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        calls.push(method);
        if (method !== "eth_chainId") time.advance(latencyMs);
        return handler(method);
      }) as EIP1193RequestFn,
    });
  return { transport, calls };
}

interface Opened {
  request: ReturnType<Transport>["request"];
  value: HyperevmTransportValue;
}

/** Instantiate with a 1000ms timeout. viem types `value` as optional, and every test here needs it. */
function instantiate(factory: Transport<"hyperevm", HyperevmTransportValue>): Opened {
  const transport = factory({ timeout: 1_000 });
  if (!transport.value) throw new Error("hyperevm() returned no value");
  return { request: transport.request, value: transport.value };
}

function open(time: Clock, endpoints: readonly MockEndpoint[], options: HyperevmTransportOptions = {}): Opened {
  return instantiate(
    hyperevm({
      endpoints: endpoints.map((endpoint, index) => ({ transport: endpoint.transport, label: `node${index}` })),
      headLag: false,
      routing: "best",
      hedge: false,
      now: time.now,
      ...options,
    }),
  );
}

/** node0 slow, node1 fast, as a session that measured both would save them. */
function learned(time: Clock, savedAt = time.now()): ScoreSnapshot {
  return {
    version: 1,
    savedAt,
    endpoints: {
      node0: { "*": { ewma: 400, tail: 400, error: 0, n: 5 }, eth_call: { ewma: 400, tail: 400, error: 0, n: 5 } },
      node1: { "*": { ewma: 20, tail: 20, error: 0, n: 5 }, eth_call: { ewma: 20, tail: 20, error: 0, n: 5 } },
    },
  };
}

function call(transport: Opened, method = "eth_call", signal?: AbortSignal): Promise<unknown> {
  return transport.request({ method, params: [] } as never, signal ? { signal } : undefined);
}

function book(transport: Opened, id: string, method = "*") {
  return transport.value.snapshot().find((entry) => entry.id === id)?.methods[method];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistEvents(events: HyperevmEvent[]): Extract<HyperevmEvent, { type: "persist" }>[] {
  return events.filter((event): event is Extract<HyperevmEvent, { type: "persist" }> => event.type === "persist");
}

describe("score snapshots", () => {
  test("scores() keeps learned books by label and leaves out heads, breaker state, and chain checks", async () => {
    const time = clock();
    const slow = mockEndpoint("slow", time, 400);
    const fast = mockEndpoint("fast", time, 20);
    const idle = mockEndpoint("idle", time, 20, () => "0x3e7");
    const transport = open(time, [slow, fast, idle], { headLag: { probeInterval: false }, breaker: { threshold: 1 } });
    await call(transport);
    await call(transport, "eth_blockNumber");
    const snapshot = transport.value.scores();
    expect(snapshot.version).toBe(1);
    expect(snapshot.savedAt).toBe(time.now());
    expect(Object.keys(snapshot.endpoints).sort()).toEqual(["node0", "node1"]);
    expect(snapshot.endpoints.node0?.eth_call).toEqual({ ewma: 400, tail: 400, error: 0, n: 1 });
    expect(snapshot.endpoints.node1?.eth_blockNumber).toEqual({ ewma: 20, tail: 20, error: 0, n: 1 });
    const text = JSON.stringify(snapshot);
    for (const field of ["head", "lag", "inflight", "quarantined", "eject", "verified", "openUntil"]) {
      expect(text).not.toContain(field);
    }
    expect(JSON.parse(text)).toEqual(snapshot);
  });

  test("a fresh instance restored from a snapshot routes to the endpoint the last session found fastest", async () => {
    const time = clock();
    const first = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const session = open(time, first);
    await call(session);
    await call(session);
    expect(first.map((endpoint) => endpoint.calls.filter((method) => method === "eth_call").length)).toEqual([1, 1]);
    const saved = JSON.stringify(session.value.scores());

    const cold = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    await call(open(time, cold));
    expect(cold[0]?.calls).toContain("eth_call");

    const warm = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const restored = open(time, warm);
    expect(restored.value.restoreScores(saved)).toBe(true);
    await call(restored);
    expect(warm[0]?.calls).toEqual([]);
    expect(warm[1]?.calls).toEqual(["eth_chainId", "eth_call"]);
  });

  test("a restored book counts as two samples and the first live sample replaces it", async () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 300)];
    const transport = open(time, nodes);
    transport.value.restoreScores(learned(time));
    expect(book(transport, "node1")).toEqual({ ewma: 20, tail: 20, error: 0, n: 2 });
    expect(book(transport, "node1", "eth_call")).toEqual({ ewma: 20, tail: 20, error: 0, n: 2 });
    await call(transport);
    expect(book(transport, "node1")).toEqual({ ewma: 300, tail: 300, error: 0, n: 1 });
    expect(book(transport, "node1", "eth_call")).toEqual({ ewma: 300, tail: 300, error: 0, n: 1 });
    // node0 has no live sample yet, so its prior stays.
    expect(book(transport, "node0")?.n).toBe(2);
  });

  test("live books win: restore only seeds books with no samples", async () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 100), mockEndpoint("b", time, 100)]);
    await call(transport);
    expect(transport.value.restoreScores(learned(time))).toBe(true);
    expect(book(transport, "node0")).toEqual({ ewma: 100, tail: 100, error: 0, n: 1 });
    expect(book(transport, "node1")?.ewma).toBe(20);
    // Everything is seeded or live now, so a second restore seeds nothing.
    expect(transport.value.restoreScores(learned(time))).toBe(false);
  });

  test("a probe does not replace a prior", async () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 100), mockEndpoint("b", time, 100)]);
    transport.value.restoreScores(learned(time));
    await transport.value.probe();
    expect(book(transport, "node1")).toEqual({ ewma: 20, tail: 20, error: 0, n: 2 });
  });

  test("ignores snapshots and books older than persist.maxAge", () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)];
    expect(open(time, nodes).value.restoreScores(learned(time, time.now() - HOUR - 1))).toBe(false);
    expect(open(time, nodes).value.restoreScores(learned(time, time.now() - HOUR))).toBe(true);
    const short = { load: () => undefined, save: () => undefined, maxAge: 1_000 };
    expect(open(time, nodes, { persist: short }).value.restoreScores(learned(time, time.now() - 1_001))).toBe(false);
    // A snapshot from well in the future is not trusted to be fresh.
    expect(open(time, nodes).value.restoreScores(learned(time, time.now() + 120_000))).toBe(false);

    const mixed = learned(time);
    const stale = mixed.endpoints.node0?.["*"];
    if (stale) stale.at = time.now() - HOUR - 1;
    const transport = open(time, nodes);
    expect(transport.value.restoreScores(mixed)).toBe(true);
    expect(book(transport, "node0")?.n).toBe(0);
    expect(book(transport, "node0", "eth_call")?.n).toBe(2);
  });

  test("a re-saved prior keeps the time it was measured, so it still ages out", () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)];
    const measuredAt = time.now();
    const first = open(time, nodes);
    first.value.restoreScores(learned(time));
    time.advance(HOUR / 2);
    const resaved = first.value.scores();
    expect(resaved.savedAt).toBe(measuredAt + HOUR / 2);
    expect(resaved.endpoints.node1?.["*"]).toEqual({ ewma: 20, tail: 20, error: 0, n: 2, at: measuredAt });
    time.advance(HOUR / 2 + 1);
    expect(open(time, nodes).value.restoreScores(resaved)).toBe(false);
  });

  test("rejects input that is not a version 1 snapshot", () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)]);
    const savedAt = time.now();
    const node = { "*": { ewma: 20, tail: 20, error: 0, n: 3 } };
    const inputs: unknown[] = [
      undefined,
      null,
      7,
      "",
      "not json",
      "[]",
      [],
      {},
      { version: 2, savedAt, endpoints: { node0: node } },
      { version: "1", savedAt, endpoints: { node0: node } },
      { version: 1, savedAt: "now", endpoints: { node0: node } },
      { version: 1, savedAt: Number.NaN, endpoints: { node0: node } },
      { version: 1, savedAt, endpoints: [node] },
      { version: 1, savedAt, endpoints: null },
      JSON.stringify({ version: 1, savedAt, endpoints: { node0: node }, pad: "x".repeat(300_000) }),
    ];
    for (const input of inputs) expect(transport.value.restoreScores(input)).toBe(false);
    expect(transport.value.scores().endpoints).toEqual({});
  });

  test("skips malformed books, unknown endpoints, and bad method names, and clamps values", () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)]);
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`m${index}`, { ewma: 1, tail: 1, error: 0, n: 1 }]),
    );
    const raw = JSON.stringify({
      version: 1,
      savedAt: time.now(),
      endpoints: {
        node0: {
          "*": { ewma: 1e12, tail: -5, error: 7, n: 1e9 },
          eth_call: { ewma: "1", tail: 1, error: 0, n: 1 },
          eth_getLogs: { ewma: 1, tail: 1, error: 0, n: 0 },
          eth_getBalance: { ewma: 1, tail: 1, error: 0 },
          eth_getCode: { ewma: 1, tail: 1, error: 0, n: 1, at: "yesterday" },
          "bad method": { ewma: 1, tail: 1, error: 0, n: 1 },
        },
        node1: many,
        "https://evil.example.test/?apikey=x": { "*": { ewma: 1, tail: 1, error: 0, n: 1 } },
        ["__proto__"]: { "*": { ewma: 1, tail: 1, error: 0, n: 1 } },
      },
    });
    expect(raw).toContain('"__proto__"');
    expect(transport.value.restoreScores(raw)).toBe(true);
    // ewma is capped at the 1000ms timeout, the slowest a live sample can be.
    expect(book(transport, "node0")).toEqual({ ewma: 1_000, tail: 0, error: 1, n: 2 });
    const node0 = transport.value.snapshot().find((entry) => entry.id === "node0");
    expect(Object.keys(node0?.methods ?? {})).toEqual(["*"]);
    const node1 = transport.value.snapshot().find((entry) => entry.id === "node1");
    expect(Object.values(node1?.methods ?? {}).filter((stat) => stat.n > 0)).toHaveLength(32);
    expect(transport.value.snapshot().map((entry) => entry.id)).toEqual(["node0", "node1"]);
    expect(({} as Record<string, unknown>)["*"]).toBeUndefined();
  });

  test("a keyed endpoint's snapshot holds its label, never the key", async () => {
    const secrets = ["HYPERPC_SECRET", "DRPC_SECRET", "apikey", "ogrpc"];
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = body.method === "eth_chainId" ? "0x3e7" : "0x10";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    };
    const saved: ScoreSnapshot[] = [];
    const transport = instantiate(
      hyperevm({
        endpoints: [
          { url: "https://hyperpc.example.test/evm?apikey=HYPERPC_SECRET", label: "hyperpc" },
          "https://lb.drpc.example.test/ogrpc/hyperliquid/DRPC_SECRET",
        ],
        fetchFn,
        headLag: false,
        hedge: false,
        routing: "best",
        persist: { load: () => undefined, save: (snapshot) => void saved.push(snapshot) },
      }),
    );
    await call(transport);
    await call(transport);
    await call(transport, "eth_getLogs");
    transport.value.close();
    expect(saved).toHaveLength(1);
    const snapshot = transport.value.scores();
    expect(Object.keys(snapshot.endpoints).length).toBeGreaterThan(0);
    for (const id of Object.keys(snapshot.endpoints)) {
      expect(["hyperpc", "https://lb.drpc.example.test"]).toContain(id);
    }
    for (const text of [JSON.stringify(snapshot), JSON.stringify(saved)]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });
});

describe("restored scores and the safety rules", () => {
  test("a restored favourite still passes its chain check, and is quarantined on the wrong chain", async () => {
    const time = clock();
    const honest = mockEndpoint("a", time, 400);
    const wrong = mockEndpoint("b", time, 20, (method) => (method === "eth_chainId" ? "0x1" : "0x1"));
    const transport = open(time, [honest, wrong]);
    transport.value.restoreScores(learned(time));
    await call(transport);
    await call(transport);
    expect(wrong.calls).toEqual(["eth_chainId"]);
    expect(honest.calls.filter((method) => method === "eth_call")).toHaveLength(2);
    expect(transport.value.snapshot().find((entry) => entry.id === "node1")?.quarantined).toBe(true);
  });

  test("the breaker overrides a restored favourite, and a saved session carries no ejection", async () => {
    const time = clock();
    const a = mockEndpoint("a", time, 400);
    const b = mockEndpoint("b", time, 20, (method) => {
      if (method === "eth_chainId") return "0x3e7";
      throw new Error("socket hang up");
    });
    const transport = open(time, [a, b], { breaker: { threshold: 1, cooldown: 60_000 } });
    transport.value.restoreScores(learned(time));
    // A failed probe ejects node1. It moves the prior's error and tail but does not replace it.
    await transport.value.probe();
    expect(book(transport, "node1")).toMatchObject({ ewma: 20, n: 2 });
    expect(transport.value.scores().endpoints.node1?.["*"]?.at).toBe(START);
    await call(transport);
    expect(b.calls.filter((method) => method === "eth_call")).toHaveLength(0);
    expect(a.calls.filter((method) => method === "eth_call")).toHaveLength(1);

    // node1 is still ejected here. A new instance restored from this session has it in rotation, so a failed
    // call fails over to it at once instead of waiting out a cooldown it never inherited.
    const next = [
      mockEndpoint("a", time, 400, (method) => {
        if (method === "eth_chainId") return "0x3e7";
        throw new Error("socket hang up");
      }),
      mockEndpoint("b", time, 20),
    ];
    const fresh = open(time, next, { breaker: { threshold: 1, cooldown: 60_000 } });
    fresh.value.restoreScores(transport.value.scores());
    await expect(call(fresh)).resolves.toBe("0x1");
    expect(next[0]?.calls).toContain("eth_call");
    expect(next[1]?.calls).toEqual(["eth_chainId", "eth_call"]);
  });

  test("a non-idempotent method goes once to the restored favourite and is not retried", async () => {
    const time = clock();
    const a = mockEndpoint("a", time, 400);
    const b = mockEndpoint("b", time, 20, (method) => {
      if (method === "eth_chainId") return "0x3e7";
      throw new Error("socket hang up");
    });
    const transport = open(time, [a, b], { retryCount: 3 });
    transport.value.restoreScores(learned(time));
    await expect(call(transport, "eth_sendTransaction")).rejects.toThrow();
    expect(b.calls.filter((method) => method === "eth_sendTransaction")).toHaveLength(1);
    expect(a.calls).not.toContain("eth_sendTransaction");
  });
});

describe("persist", () => {
  test("load runs once per instance, on the first request, not when the transport is built", async () => {
    const time = clock();
    let loads = 0;
    const factory = hyperevm({
      endpoints: [mockEndpoint("a", time, 1).transport],
      headLag: false,
      now: time.now,
      persist: {
        load: (): undefined => {
          loads += 1;
        },
        save: () => undefined,
      },
    });
    const transport = instantiate(factory);
    expect(loads).toBe(0);
    await call(transport);
    await call(instantiate(factory));
    await call(transport);
    expect(loads).toBe(1);
    transport.value.close();
  });

  test("a synchronous load, or one that has already settled, seeds the first pick", async () => {
    for (const load of [(time: Clock) => learned(time), async (time: Clock) => JSON.stringify(learned(time))]) {
      const time = clock();
      const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
      const transport = open(time, nodes, { persist: { load: () => load(time), save: () => undefined } });
      await call(transport);
      expect(nodes[0]?.calls).toEqual([]);
      expect(nodes[1]?.calls).toEqual(["eth_chainId", "eth_call"]);
      transport.value.close();
    }
  });

  test("a slow load never holds a call, and lands when it settles", async () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const pending = deferred<unknown>();
    const transport = open(time, nodes, { persist: { load: () => pending.promise, save: () => undefined } });
    await call(transport);
    expect(nodes[0]?.calls).toContain("eth_call");
    pending.resolve(learned(time));
    await sleep(0);
    expect(book(transport, "node1")?.n).toBe(2);
    // node0 was measured live before the load landed. Its live book stays.
    expect(book(transport, "node0")).toEqual({ ewma: 400, tail: 400, error: 0, n: 1 });
    transport.value.close();
  });

  test("an aborted first request rejects at once while the load is pending, and the load still lands", async () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const pending = deferred<unknown>();
    const transport = open(time, nodes, { persist: { load: () => pending.promise, save: () => undefined } });
    const controller = new AbortController();
    controller.abort();
    await expect(call(transport, "eth_call", controller.signal)).rejects.toThrow();
    pending.resolve(learned(time));
    await sleep(0);
    await call(transport);
    expect(nodes[1]?.calls).toContain("eth_call");
    transport.value.close();
  });

  test("a failing or invalid load fires a persist event and the call succeeds", async () => {
    const loads: (() => unknown)[] = [
      () => {
        throw new Error("storage blocked");
      },
      () => Promise.reject(new Error("kv down")),
      () => "{not json",
      () => null,
    ];
    const seen: string[] = [];
    for (const load of loads) {
      const time = clock();
      const events: HyperevmEvent[] = [];
      const transport = open(time, [mockEndpoint("a", time, 1)], {
        persist: { load, save: () => undefined },
        onEvent: (event) => events.push(event),
      });
      await expect(call(transport)).resolves.toBe("0x1");
      await sleep(0);
      seen.push(...persistEvents(events).map((event) => `${event.operation}:${event.error.message}`));
      transport.value.close();
    }
    expect(seen).toEqual(["load:storage blocked", "load:kv down", "load:The stored score snapshot is not valid."]);
  });

  test("save is throttled to saveInterval and runs again on close()", async () => {
    const time = clock();
    const saves: ScoreSnapshot[] = [];
    const transport = open(time, [mockEndpoint("a", time, 5)], {
      persist: { load: () => undefined, save: (snapshot) => void saves.push(snapshot), saveInterval: 40 },
    });
    const started = Date.now();
    for (let index = 0; index < 15; index += 1) {
      await call(transport);
      await sleep(10);
    }
    // About 150ms of steady traffic at one save per 40ms is three or four saves, not fifteen.
    expect(saves.length).toBeGreaterThanOrEqual(2);
    expect(saves.length).toBeLessThanOrEqual(Math.floor((Date.now() - started) / 40) + 1);
    const before = saves.length;
    transport.value.close();
    expect(saves).toHaveLength(before + 1);
    expect(saves.at(-1)?.endpoints.node0?.eth_call?.n).toBe(15);
    await sleep(60);
    expect(saves).toHaveLength(before + 1);
  });

  test("defaults to one save per 10 seconds", async () => {
    const time = clock();
    let saves = 0;
    const transport = open(time, [mockEndpoint("a", time, 5)], {
      persist: {
        load: () => undefined,
        save: (): void => {
          saves += 1;
        },
      },
    });
    for (let index = 0; index < 5; index += 1) await call(transport);
    await sleep(30);
    expect(saves).toBe(0);
    transport.value.close();
    expect(saves).toBe(1);
  });

  test("close() saves nothing before the first request or while the load is pending", async () => {
    const time = clock();
    let saves = 0;
    let loads = 0;
    const save = (): void => {
      saves += 1;
    };
    open(time, [mockEndpoint("a", time, 1)], {
      persist: {
        load: (): undefined => {
          loads += 1;
        },
        save,
      },
    }).value.close();
    expect([loads, saves]).toEqual([0, 0]);

    const pending = deferred<unknown>();
    const transport = open(time, [mockEndpoint("a", time, 1)], {
      persist: { load: () => pending.promise, save, saveInterval: 0 },
    });
    await call(transport);
    await sleep(10);
    transport.value.close();
    expect(saves).toBe(0);
    // The stored snapshot arriving after close() is not applied.
    pending.resolve(learned(time));
    await sleep(0);
    expect(book(transport, "node1")).toBeUndefined();
  });

  test("a load that never settles stops holding saves back after one timeout", async () => {
    const time = clock();
    const events: HyperevmEvent[] = [];
    let saves = 0;
    const factory = hyperevm({
      endpoints: [{ transport: mockEndpoint("a", time, 1).transport, label: "node0" }],
      headLag: false,
      now: time.now,
      onEvent: (event) => events.push(event),
      persist: {
        // On Workers, a load started by an invocation that ended never settles.
        load: () => new Promise(() => {}),
        save: (): void => {
          saves += 1;
        },
        saveInterval: 0,
      },
    });
    const transport = factory({ timeout: 40 });
    await transport.request({ method: "eth_call", params: [] } as never);
    await sleep(10);
    expect(saves).toBe(0);
    await sleep(50);
    await transport.request({ method: "eth_call", params: [] } as never);
    await sleep(10);
    expect(saves).toBeGreaterThan(0);
    expect(persistEvents(events).map((event) => event.operation)).toEqual(["load"]);
    transport.value?.close();
  });

  test("a save timer the runtime dropped is armed again by a later request", async () => {
    const time = clock();
    let saves = 0;
    const transport = open(time, [mockEndpoint("a", time, 1)], {
      persist: {
        load: () => undefined,
        save: (): void => {
          saves += 1;
        },
        saveInterval: 40,
      },
    });
    // Workers cancel the timers of an invocation when it ends. Drop the save timer the first request arms.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) =>
      ms !== undefined && ms > 0 && ms <= 40
        ? realSetTimeout(() => undefined, 0)
        : realSetTimeout(handler, ms, ...rest)) as typeof setTimeout;
    try {
      await call(transport);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    await sleep(60);
    expect(saves).toBe(0);
    await call(transport);
    await sleep(10);
    expect(saves).toBe(1);
    transport.value.close();
  });

  test("save errors fire a persist event and calls keep working", async () => {
    for (const save of [
      (): void => {
        throw new Error("quota exceeded");
      },
      (): Promise<void> => Promise.reject(new Error("kv write failed")),
    ] satisfies ScorePersistence["save"][]) {
      const time = clock();
      const events: HyperevmEvent[] = [];
      const transport = open(time, [mockEndpoint("a", time, 1)], {
        persist: { load: () => undefined, save, saveInterval: 0 },
        onEvent: (event) => events.push(event),
      });
      await call(transport);
      await sleep(10);
      await expect(call(transport)).resolves.toBe("0x1");
      transport.value.close();
      await sleep(0);
      const errors = persistEvents(events);
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.every((event) => event.operation === "save")).toBe(true);
    }
  });

  test("rejects a negative or non-finite maxAge or saveInterval", () => {
    const base = { load: () => undefined, save: () => undefined };
    const time = clock();
    const nodes = [mockEndpoint("a", time, 1)];
    expect(() => open(time, nodes, { persist: { ...base, maxAge: -1 } })).toThrow("persist.maxAge");
    expect(() => open(time, nodes, { persist: { ...base, saveInterval: Number.NaN } })).toThrow("persist.saveInterval");
  });
});

describe("localStoragePersistence", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  function stubStorage(value: unknown): void {
    Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  }

  function memoryStorage(): Map<string, string> & Pick<Storage, "getItem" | "setItem"> {
    const items = new Map<string, string>();
    return Object.assign(items, {
      getItem: (key: string): string | null => items.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        items.set(key, value);
      },
    });
  }

  test("is a no-op where localStorage does not exist", async () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    const persistence = localStoragePersistence("scores");
    expect(persistence.load()).toBeUndefined();
    const time = clock();
    expect(() => persistence.save(learned(time))).not.toThrow();
  });

  test("round-trips a snapshot into a new session", async () => {
    const storage = memoryStorage();
    stubStorage(storage);
    const time = clock();
    const first = open(time, [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)], {
      persist: localStoragePersistence("hyperevm:scores"),
    });
    await call(first);
    await call(first);
    first.value.close();
    expect(JSON.parse(storage.get("hyperevm:scores") ?? "{}").version).toBe(1);

    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const second = open(time, nodes, { persist: localStoragePersistence("hyperevm:scores") });
    await call(second);
    expect(nodes[0]?.calls).toEqual([]);
    second.value.close();
  });

  test("swallows storage that throws on access, read, or write", () => {
    const time = clock();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    const blocked = localStoragePersistence("scores");
    expect(blocked.load()).toBeUndefined();
    expect(() => blocked.save(learned(time))).not.toThrow();

    const fail = (): never => {
      throw new Error("QuotaExceededError");
    };
    stubStorage({ getItem: fail, setItem: fail });
    const full = localStoragePersistence("scores");
    expect(full.load()).toBeUndefined();
    expect(() => full.save(learned(time))).not.toThrow();

    stubStorage({});
    expect(localStoragePersistence("scores").load()).toBeUndefined();
  });
});
