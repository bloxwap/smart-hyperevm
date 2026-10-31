import { describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { AllEndpointsFailedError } from "../../src/_errors.ts";
import { type HyperevmEvent, type HyperevmTransportOptions, hyperevm } from "../../src/transport/mod.ts";

interface MockEndpoint {
  transport: Transport;
  calls: string[];
}

function mockEndpoint(name: string, handler: (method: string) => unknown | Promise<unknown>): MockEndpoint {
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

function open(options: HyperevmTransportOptions) {
  return hyperevm({
    headLag: false,
    routing: "best",
    retryCount: 2,
    hedge: false,
    race: true,
    // These mocks answer every method alike. Chain checks have their own test below.
    verifyChainId: false,
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
}

function hang(): Promise<never> {
  return new Promise(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

/** Answers `eth_chainId` with 999 and everything else through `read`. */
function onChain(read: (method: string) => unknown | Promise<unknown>): (method: string) => unknown | Promise<unknown> {
  return (method) => (method === "eth_chainId" ? "0x3e7" : read(method));
}

const reads = (endpoint: MockEndpoint): string[] => endpoint.calls.filter((method) => method !== "eth_chainId");

describe("race option", () => {
  test("is off by default", async () => {
    const a = mockEndpoint("a", () => "0xa");
    const b = mockEndpoint("b", () => "0xb");
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [a.transport, b.transport], race: undefined, onEvent: (e) => events.push(e) });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    expect(b.calls).toHaveLength(0);
    expect(events.some((event) => event.type === "race")).toBe(false);
  });

  test("true races the two best endpoints and returns the first answer", async () => {
    const a = mockEndpoint("a", hang);
    const b = mockEndpoint("b", () => "0xb");
    const c = mockEndpoint("c", () => "0xc");
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [a.transport, b.transport, c.transport], onEvent: (e) => events.push(e) });
    const started = Date.now();
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xb");
    expect(Date.now() - started).toBeLessThan(200);
    expect([a.calls, b.calls, c.calls]).toEqual([["eth_call"], ["eth_call"], []]);
    expect(events).toContainEqual({ type: "race", endpoints: ["transport:0", "transport:1"], method: "eth_call" });
  });

  test("races in score order, not by p2c draw", async () => {
    const nodes = ["a", "b", "c"].map((name) => mockEndpoint(name, () => `0x${name}`));
    const [a, b, c] = nodes as [MockEndpoint, MockEndpoint, MockEndpoint];
    const events: HyperevmEvent[] = [];
    const client = open({
      // Higher weight scores better: c, then b, then a. p2c with this draw would compare a and b only.
      endpoints: [
        { transport: a.transport, label: "a", weight: 1 },
        { transport: b.transport, label: "b", weight: 5 },
        { transport: c.transport, label: "c", weight: 10 },
      ],
      routing: "p2c",
      random: () => 0,
      onEvent: (e) => events.push(e),
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xc");
    expect(a.calls).toHaveLength(0);
    expect(events).toContainEqual({ type: "race", endpoints: ["c", "b"], method: "eth_call" });
  });

  test("width is capped at the endpoints that can serve the call", async () => {
    const a = mockEndpoint("a", () => "0xa");
    const b = mockEndpoint("b", () => "0xb");
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [a.transport, b.transport], race: { width: 5 }, onEvent: (e) => events.push(e) });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    expect(events.filter((event) => event.type === "race")).toHaveLength(1);
    expect(events.filter((event) => event.type === "request")).toHaveLength(2);

    const solo = mockEndpoint("solo", () => "0x1");
    const lone: HyperevmEvent[] = [];
    await open({ endpoints: [solo.transport], onEvent: (e) => lone.push(e) }).request({ method: "eth_call" });
    expect(lone.some((event) => event.type === "race")).toBe(false);
  });

  test.each([1, 0, 2.5, Number.NaN])("width %p throws", (width) => {
    expect(() => hyperevm({ race: { width } })).toThrow(/race\.width/);
  });
});

describe("racer failures", () => {
  test("a failed racer does not fail the call while another is running", async () => {
    const a = mockEndpoint("a", () => Promise.reject(rpcError("internal error", -32603)));
    const b = mockEndpoint("b", async () => {
      await sleep(30);
      return "0xb";
    });
    const c = mockEndpoint("c", () => "0xc");
    const client = open({ endpoints: [a.transport, b.transport, c.transport] });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xb");
    expect(c.calls).toHaveLength(0);
  });

  test("when every racer fails, failover skips them and the error lists each one", async () => {
    const a = mockEndpoint("a", () => Promise.reject(rpcError("internal error", -32603)));
    const b = mockEndpoint("b", () => Promise.reject(rpcError("internal error", -32603)));
    const c = mockEndpoint("c", () => "0xc");
    const events: HyperevmEvent[] = [];
    const client = open({ endpoints: [a.transport, b.transport, c.transport], onEvent: (e) => events.push(e) });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xc");
    expect([a.calls, b.calls, c.calls]).toEqual([["eth_call"], ["eth_call"], ["eth_call"]]);
    expect(events).toContainEqual({ type: "failover", from: "transport:0", to: "transport:2", method: "eth_call" });
    // Only the first attempt races.
    expect(events.filter((event) => event.type === "race")).toHaveLength(1);

    const x = mockEndpoint("x", () => Promise.reject(rpcError("internal error", -32603)));
    const y = mockEndpoint("y", () => Promise.reject(rpcError("internal error", -32603)));
    const failing = open({ endpoints: [x.transport, y.transport], retryCount: 0 });
    const error = await failing.request({ method: "eth_call", params: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    expect((error as AllEndpointsFailedError).errors).toHaveLength(2);
  });

  test("a terminal answer settles the race without waiting for a hung racer", async () => {
    const a = mockEndpoint("a", () => Promise.reject(rpcError("execution reverted: nope", 3)));
    const b = mockEndpoint("b", hang);
    const client = open({ endpoints: [a.transport, b.transport], timeout: 2_000 });
    const started = Date.now();
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow(/execution reverted/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("losers", () => {
  test("finish after the winner returns and keep their latency sample", async () => {
    let clock = 1_000;
    const events: HyperevmEvent[] = [];
    const slow = mockEndpoint("slow", async () => {
      await sleep(20);
      clock += 100;
      return "0xslow";
    });
    const fast = mockEndpoint("fast", () => "0xfast");
    const client = open({
      endpoints: [
        { transport: slow.transport, label: "slow" },
        { transport: fast.transport, label: "fast" },
      ],
      now: () => clock,
      onEvent: (e) => events.push(e),
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xfast");
    expect(client.value?.snapshot().find((entry) => entry.id === "slow")?.inflight).toBe(1);
    await sleep(60);
    const loser = client.value?.snapshot().find((entry) => entry.id === "slow");
    expect(loser?.inflight).toBe(0);
    expect(loser?.methods.eth_call).toMatchObject({ n: 1, ewma: 100, error: 0 });
    expect(events).toContainEqual({
      type: "success",
      endpoint: "slow",
      method: "eth_call",
      latencyMs: 100,
      hedged: false,
    });
  });

  test("a loser the caller aborts is not an endpoint failure and releases its in-flight count", async () => {
    const events: HyperevmEvent[] = [];
    const hung = mockEndpoint("hung", hang);
    const fast = mockEndpoint("fast", () => "0xfast");
    const client = open({
      endpoints: [
        { transport: hung.transport, label: "hung" },
        { transport: fast.transport, label: "fast" },
      ],
      breaker: { threshold: 1 },
      // A coalesced call runs under a private signal, so the caller's abort after it settled would not reach the loser.
      coalesce: false,
      onEvent: (e) => events.push(e),
    });
    const controller = new AbortController();
    expect(await client.request({ method: "eth_call", params: [] }, { signal: controller.signal })).toBe("0xfast");
    controller.abort();
    await sleep(10);
    const loser = client.value?.snapshot().find((entry) => entry.id === "hung");
    expect(loser?.inflight).toBe(0);
    expect(loser?.methods["*"]).toMatchObject({ n: 0, error: 0 });
    expect(events.some((event) => event.type === "error" || event.type === "eject")).toBe(false);
  });

  test("a caller abort mid-race rejects at once and counts against no racer", async () => {
    const events: HyperevmEvent[] = [];
    const a = mockEndpoint("a", hang);
    const b = mockEndpoint("b", hang);
    const client = open({ endpoints: [a.transport, b.transport], timeout: 5_000, onEvent: (e) => events.push(e) });
    const controller = new AbortController();
    const pending = client.request({ method: "eth_call", params: [] }, { signal: controller.signal });
    await sleep(10);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(a.calls.length + b.calls.length).toBe(2);
    expect(events.some((event) => event.type === "error" || event.type === "failover")).toBe(false);
    for (const entry of client.value?.snapshot() ?? []) expect(entry.inflight).toBe(0);
  });
});

describe("what never races", () => {
  test.each(["eth_sendRawTransaction", "eth_sendTransaction", "eth_getFilterChanges", "custom_write"])(
    "%s goes to one endpoint",
    async (method) => {
      const a = mockEndpoint("a", () => "0xa");
      const b = mockEndpoint("b", () => "0xb");
      const client = open({
        endpoints: [a.transport, b.transport],
        nonIdempotentMethods: ["custom_write"],
        hedge: { minDelay: 1, multiplier: 0 },
      });
      expect(await client.request({ method, params: ["0x02"] } as any)).toBe("0xa");
      expect(b.calls).toHaveLength(0);
    },
  );

  test("an ejected endpoint is not raced", async () => {
    let failB = true;
    const a = mockEndpoint("a", () => "0xa");
    const b = mockEndpoint("b", () => (failB ? Promise.reject(rpcError("internal error", -32603)) : "0xb"));
    const c = mockEndpoint("c", () => "0xc");
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [a.transport, b.transport, c.transport],
      breaker: { threshold: 1, cooldown: 60_000 },
      now: () => 0,
      onEvent: (e) => events.push(e),
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    await sleep(5);
    expect(events.some((event) => event.type === "eject" && event.endpoint === "transport:1")).toBe(true);
    failB = false;
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "race").at(-1)).toMatchObject({
      endpoints: ["transport:0", "transport:2"],
    });
  });

  test("when every endpoint is ejected, the first attempt goes to one endpoint, not a race", async () => {
    const fail = (): Promise<never> => Promise.reject(rpcError("internal error", -32603));
    let healthy = false;
    const a = mockEndpoint("a", () => (healthy ? "0xa" : fail()));
    const b = mockEndpoint("b", () => (healthy ? "0xb" : fail()));
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [a.transport, b.transport],
      breaker: { threshold: 1, cooldown: 60_000 },
      retryCount: 0,
      now: () => 0,
      onEvent: (e) => events.push(e),
    });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    expect(events.filter((event) => event.type === "eject")).toHaveLength(2);
    healthy = true;
    events.length = 0;
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    expect(events.some((event) => event.type === "race")).toBe(false);
    expect(b.calls).toHaveLength(1);
  });

  test("unverified endpoints are checked in the background and quarantined ones never race", async () => {
    const a = mockEndpoint(
      "a",
      onChain(() => "0xa"),
    );
    const b = mockEndpoint(
      "b",
      onChain(() => "0xb"),
    );
    const wrong = mockEndpoint("wrong", (method) => (method === "eth_chainId" ? "0x1" : "0xwrong"));
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: wrong.transport, label: "wrong" },
        { transport: b.transport, label: "b" },
      ],
      verifyChainId: true,
      race: { width: 3 },
      onEvent: (e) => events.push(e),
    });
    // a is checked before it serves. The others have not passed a check, so the first call does not race them.
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    expect(reads(b)).toHaveLength(0);
    await sleep(10);
    expect(events).toContainEqual({ type: "quarantine", endpoint: "wrong", chainId: 1, expected: 999 });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xa");
    expect(reads(b)).toEqual(["eth_call"]);
    expect(wrong.calls).toEqual(["eth_chainId"]);
    expect(events.filter((event) => event.type === "race")).toEqual([
      { type: "race", endpoints: ["a", "b"], method: "eth_call" },
    ]);
  });
});

describe("with a hedge", () => {
  test("the hedge adds the next endpoint on top of the racers", async () => {
    const a = mockEndpoint("a", hang);
    const b = mockEndpoint("b", hang);
    const c = mockEndpoint("c", () => "0xc");
    const d = mockEndpoint("d", () => "0xd");
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [a.transport, b.transport, c.transport, d.transport],
      hedge: { minDelay: 20, multiplier: 0 },
      onEvent: (e) => events.push(e),
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xc");
    expect(d.calls).toHaveLength(0);
    const kinds = events.filter((event) => event.type === "race" || event.type === "hedge");
    expect(kinds).toEqual([
      { type: "race", endpoints: ["transport:0", "transport:1"], method: "eth_call" },
      { type: "hedge", endpoint: "transport:2", method: "eth_call" },
    ]);
  });

  test("a race that fails before the hedge delay fails over instead of hedging", async () => {
    const fail = (): Promise<never> => Promise.reject(rpcError("internal error", -32603));
    const a = mockEndpoint("a", fail);
    const b = mockEndpoint("b", fail);
    const c = mockEndpoint("c", () => "0xc");
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [a.transport, b.transport, c.transport],
      hedge: { minDelay: 200, multiplier: 0 },
      onEvent: (e) => events.push(e),
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xc");
    expect(events.some((event) => event.type === "hedge")).toBe(false);
    expect(events.some((event) => event.type === "failover")).toBe(true);
  });
});
