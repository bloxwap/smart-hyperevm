/**
 * How the router-parity features work together: racing, latest pinning, coalescing, request budgets,
 * warm-started scores, and paused probes. Each feature has its own suite. These cover where they meet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import {
  type HyperevmEvent,
  type HyperevmTransportOptions,
  type HyperevmTransportValue,
  type ScoreSnapshot,
  smartHyperevm,
} from "../../src/transport/mod.ts";
import { BASELINE } from "./_baseline.ts";

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

/** Answers chain 999, `eth_blockNumber` with `head`, and everything else through `read` (default `0x1`). */
function node(
  name: string,
  head = 0x10,
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
        if (method === "eth_blockNumber") return hex(head);
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
}

function open(options: HyperevmTransportOptions): Opened {
  const transport = smartHyperevm({
    ...BASELINE,
    routing: "best",
    retryCount: 2,
    hedge: false,
    verifyChainId: false,
    headLag: { probeInterval: false },
    // A fixed clock: heads stay fresh and budgets never refill, so every count below is exact.
    now: () => START,
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
  if (!transport.value) throw new Error("smartHyperevm() returned no transport value.");
  return { request: transport.request, value: transport.value };
}

const START = 10_000_000;
const TX = { to: "0x000000000000000000000000000000000000dead", data: "0x" };

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

function tokens(client: Opened): Record<string, number | null> {
  return Object.fromEntries(client.value.snapshot().map((entry) => [entry.id, entry.tokens]));
}

function races(events: readonly HyperevmEvent[]): string[][] {
  return events.flatMap((event) => (event.type === "race" ? [event.endpoints] : []));
}

describe("race + pinLatest", () => {
  test("every racer reads the same pinned block, and eth_blockNumber answers locally without a token", async () => {
    const events: HyperevmEvent[] = [];
    const a = node("a", 100);
    const b = node("b", 101);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      race: true,
      pinLatest: true,
      budget: { rps: 1, burst: 10 },
      onEvent: (event) => events.push(event),
    });
    await client.value.probe();
    expect(tokens(client)).toEqual({ a: 9, b: 9 });

    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(races(events)).toHaveLength(1);
    // The floor of 100 and 101: a block both racers hold.
    expect(a.reads()).toEqual([{ method: "eth_call", params: [TX, "0x64"] }]);
    expect(b.reads()).toEqual([{ method: "eth_call", params: [TX, "0x64"] }]);
    expect(tokens(client)).toEqual({ a: 8, b: 8 });

    const probes = a.count("eth_blockNumber") + b.count("eth_blockNumber");
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(a.count("eth_blockNumber") + b.count("eth_blockNumber")).toBe(probes);
    expect(tokens(client)).toEqual({ a: 8, b: 8 });
    expect(events.some((event) => event.type === "coalesce")).toBe(false);
  });

  test("a pinned and an unpinned spelling of the same read share one race", async () => {
    const events: HyperevmEvent[] = [];
    const answer = deferred<unknown>();
    const a = node("a", 100, () => answer.promise);
    const b = node("b", 100, () => answer.promise);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      race: true,
      pinLatest: true,
      onEvent: (event) => events.push(event),
    });
    await client.value.probe();
    // An implied latest, an explicit one, and the block they pin to are the same read once pinned.
    const pending = [
      client.request({ method: "eth_call", params: [TX] }),
      client.request({ method: "eth_call", params: [TX, "latest"] }),
      client.request({ method: "eth_call", params: [TX, "0x64"] }),
    ];
    await sleep(5);
    answer.resolve("0xshared");
    expect(await Promise.all(pending)).toEqual(["0xshared", "0xshared", "0xshared"]);
    expect(a.reads()).toHaveLength(1);
    expect(b.reads()).toHaveLength(1);
    expect(races(events)).toHaveLength(1);
    expect(events.filter((event) => event.type === "coalesce")).toHaveLength(2);
  });
});

describe("coalesce + abort", () => {
  test("one caller aborts, the other still gets the shared race's result", async () => {
    const events: HyperevmEvent[] = [];
    const answer = deferred<unknown>();
    const a = node("a", 0x10, () => answer.promise);
    const b = node("b", 0x10, () => answer.promise);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      headLag: false,
      race: true,
      onEvent: (event) => events.push(event),
    });
    const first = new AbortController();
    const second = new AbortController();
    const aborted = client.request({ method: "eth_call", params: [TX, "latest"] }, { signal: first.signal });
    const kept = client.request({ method: "eth_call", params: [TX, "latest"] }, { signal: second.signal });
    await sleep(5);
    first.abort();
    await expect(aborted).rejects.toThrow();
    answer.resolve("0xshared");
    expect(await kept).toBe("0xshared");
    // One race of two racers served both callers.
    expect(a.reads().length + b.reads().length).toBe(2);
    expect(races(events)).toHaveLength(1);
    expect(events.filter((event) => event.type === "coalesce")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});

describe("budget + race", () => {
  test("an out-of-budget endpoint is not raced, and the race takes the next funded one", async () => {
    const events: HyperevmEvent[] = [];
    const a = node("a");
    const b = node("b");
    const c = node("c");
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b", rps: 1, burst: 1 },
        { transport: c.transport, label: "c" },
      ],
      race: true,
      onEvent: (event) => events.push(event),
    });
    // The probe spends b's only token. The fixed clock never refills it.
    await client.value.probe();
    expect(tokens(client)).toEqual({ a: null, b: 0, c: null });

    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(races(events)).toEqual([["a", "c"]]);
    expect(b.reads()).toHaveLength(0);
    expect(a.reads()).toHaveLength(1);
    expect(c.reads()).toHaveLength(1);
  });

  test("a race narrows to the lead when it is the only endpoint with a token", async () => {
    const events: HyperevmEvent[] = [];
    const a = node("a");
    const b = node("b");
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a", rps: 1, burst: 2 },
        { transport: b.transport, label: "b", rps: 1, burst: 1 },
      ],
      race: true,
      onEvent: (event) => events.push(event),
    });
    await client.value.probe();
    expect(tokens(client)).toEqual({ a: 1, b: 0 });
    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(races(events)).toHaveLength(0);
    expect(a.reads()).toHaveLength(1);
    expect(b.reads()).toHaveLength(0);
    expect(tokens(client)).toEqual({ a: 0, b: 0 });
  });
});

describe("persist + race", () => {
  test("restored scores pick the racers before any live sample", async () => {
    const events: HyperevmEvent[] = [];
    const slow = { ewma: 400, tail: 400, error: 0, n: 5 };
    const snapshot: ScoreSnapshot = {
      version: 1,
      savedAt: START,
      endpoints: {
        a: { "*": slow, eth_call: slow },
        b: { "*": { ewma: 30, tail: 30, error: 0, n: 5 }, eth_call: { ewma: 30, tail: 30, error: 0, n: 5 } },
        c: { "*": { ewma: 10, tail: 10, error: 0, n: 5 }, eth_call: { ewma: 10, tail: 10, error: 0, n: 5 } },
      },
    };
    const a = node("a");
    const b = node("b");
    const c = node("c");
    const client = open({
      // Listed slowest first, so without the snapshot a and b would race.
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
        { transport: c.transport, label: "c" },
      ],
      headLag: false,
      race: true,
      persist: { load: () => snapshot, save: () => undefined },
      onEvent: (event) => events.push(event),
    });
    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(races(events)).toEqual([["c", "b"]]);
    expect(a.reads()).toHaveLength(0);
    client.value.close();
  });
});

describe("inactive probes + budgets", () => {
  test("ticks send nothing while inactive, and skip a spent endpoint once active again", async () => {
    let active = false;
    const a = node("a");
    const b = node("b");
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a", rps: 1, burst: 1 },
        { transport: b.transport, label: "b" },
      ],
      headLag: { probeInterval: 5 },
      isActive: () => active,
    });
    // An explicit probe runs while inactive, and spends a's only token.
    await client.value.probe();
    expect(tokens(client)).toEqual({ a: 0, b: null });
    // The call goes to b, the only endpoint with budget, and starts the probe timer.
    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(a.reads()).toHaveLength(0);
    expect(b.reads()).toHaveLength(1);

    await sleep(40);
    expect(a.count("eth_blockNumber")).toBe(1);
    expect(b.count("eth_blockNumber")).toBe(1);

    active = true;
    await until(() => b.count("eth_blockNumber") >= 3);
    expect(a.count("eth_blockNumber")).toBe(1);
    expect(tokens(client)).toEqual({ a: 0, b: null });

    client.value.close();
    const after = b.count("eth_blockNumber");
    await sleep(30);
    expect(b.count("eth_blockNumber")).toBe(after);
  });
});

describe("cache + race + pinLatest + budget", () => {
  test("a hit sends nothing and spends no token; the miss before it is raced and pinned like any read", async () => {
    const events: HyperevmEvent[] = [];
    const a = node("a", 100);
    const b = node("b", 100);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      race: true,
      pinLatest: true,
      cache: { refreshInterval: false },
      budget: { rps: 1, burst: 10 },
      onEvent: (event) => events.push(event),
    });
    await client.value.probe();
    expect(tokens(client)).toEqual({ a: 9, b: 9 });

    expect(await client.request({ method: "eth_call", params: [TX] })).toBe("0x1");
    expect(races(events)).toHaveLength(1);
    expect(a.reads()).toEqual([{ method: "eth_call", params: [TX, "0x64"] }]);
    expect(tokens(client)).toEqual({ a: 8, b: 8 });

    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(races(events)).toHaveLength(1);
    expect(tokens(client)).toEqual({ a: 8, b: 8 });
    expect(events.filter((event) => event.type === "coalesce")).toHaveLength(0);
    expect(client.value.cacheStats()).toMatchObject({ hits: 1, misses: 1 });
    // eth_blockNumber is still the pin's answer.
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
    expect(tokens(client)).toEqual({ a: 8, b: 8 });
  });

  test("a refresh spends one token on one holder of the newest head, and the read after it is a hit", async () => {
    const events: HyperevmEvent[] = [];
    const a = node("a", 100);
    const b = node("b", 101);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      race: true,
      pinLatest: true,
      cache: { refreshInterval: false },
      budget: { rps: 1, burst: 4 },
      onEvent: (event) => events.push(event),
    });
    await client.value.probe();
    // The read races both at the floor, 100.
    await client.request({ method: "eth_call", params: [TX] });
    expect(tokens(client)).toEqual({ a: 2, b: 2 });
    expect(a.reads()).toEqual([{ method: "eth_call", params: [TX, "0x64"] }]);

    // Heads noted again: the hot key is a block behind the top, so it is refreshed there, on b alone, unraced.
    await client.value.probe();
    await until(() => b.count("eth_call") === 2);
    await sleep(5);
    expect(b.reads().at(-1)).toEqual({ method: "eth_call", params: [TX, "0x65"] });
    expect(a.count("eth_call")).toBe(1);
    expect(tokens(client)).toEqual({ a: 1, b: 0 });
    expect(races(events)).toHaveLength(1);
    expect(client.value.cacheStats()).toMatchObject({ refreshes: 1, hits: 0, misses: 1 });

    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(tokens(client)).toEqual({ a: 1, b: 0 });
    expect(client.value.cacheStats()).toMatchObject({ hits: 1 });
  });
});

describe("what stays out of every feature", () => {
  test("concurrent identical raw transactions are not raced, coalesced, or pinned", async () => {
    const events: HyperevmEvent[] = [];
    const a = node("a", 100, (method) => (method === "eth_sendRawTransaction" ? `0x${"ab".repeat(32)}` : "0x1"));
    const b = node("b", 100, (method) => (method === "eth_sendRawTransaction" ? `0x${"ab".repeat(32)}` : "0x1"));
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b" },
      ],
      race: true,
      pinLatest: true,
      onEvent: (event) => events.push(event),
    });
    await client.value.probe();
    const raw = "0x02f8";
    await Promise.all([
      client.request({ method: "eth_sendRawTransaction", params: [raw] }),
      client.request({ method: "eth_sendRawTransaction", params: [raw] }),
    ]);
    const sends = [...a.reads(), ...b.reads()];
    expect(sends).toEqual([
      { method: "eth_sendRawTransaction", params: [raw] },
      { method: "eth_sendRawTransaction", params: [raw] },
    ]);
    expect(events.some((event) => event.type === "race" || event.type === "coalesce")).toBe(false);
  });
});

describe("close", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });

  test("stops the probe timer, removes the visibility listener, and saves scores once", async () => {
    const listeners = new Set<() => void>();
    const document = {
      visibilityState: "visible",
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
    const saved: ScoreSnapshot[] = [];
    const a = node("a");
    const client = open({
      endpoints: [{ transport: a.transport, label: "a" }],
      headLag: { probeInterval: 5 },
      // A long interval, so the only save is the one close() makes.
      persist: { load: () => undefined, save: (snapshot) => void saved.push(snapshot), saveInterval: 60_000 },
    });
    expect(await client.request({ method: "eth_call", params: [TX, "latest"] })).toBe("0x1");
    expect(listeners.size).toBe(1);
    await until(() => a.count("eth_blockNumber") >= 1);

    client.value.close();
    expect(listeners.size).toBe(0);
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]?.endpoints ?? {})).toEqual(["a"]);
    const probes = a.count("eth_blockNumber");
    await sleep(30);
    expect(a.count("eth_blockNumber")).toBe(probes);
    client.value.close();
    expect(saved).toHaveLength(1);
    await expect(client.request({ method: "eth_call", params: [TX, "latest"] })).rejects.toThrow();
  });
});
