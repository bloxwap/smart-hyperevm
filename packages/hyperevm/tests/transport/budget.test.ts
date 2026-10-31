import { describe, expect, test } from "bun:test";
import { createTransport, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { BudgetExhaustedError } from "../../src/_errors.ts";
import { Budgets, defaultBurst, resolveDefaultBudget, resolveEndpointBudget } from "../../src/transport/_budget.ts";
import { hyperevm, type HyperevmEvent, type HyperevmTransportOptions } from "../../src/transport/mod.ts";
import { BASELINE } from "./_baseline.ts";

interface MockEndpoint {
  transport: Transport;
  calls: string[];
}

function mockEndpoint(handler: (method: string, seen: number) => unknown | Promise<unknown>): MockEndpoint {
  const calls: string[] = [];
  const transport: Transport = () =>
    createTransport({
      key: "mock",
      name: "mock",
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        const seen = calls.filter((call) => call === method).length;
        calls.push(method);
        return handler(method, seen);
      }) as EIP1193RequestFn,
    });
  return { transport, calls };
}

const answers = (method: string): unknown => (method === "eth_chainId" ? "0x3e7" : "0x1");

function open(options: HyperevmTransportOptions, timeout = 1_000) {
  return hyperevm({
    ...BASELINE,
    headLag: false,
    routing: "best",
    retryCount: 2,
    hedge: false,
    verifyChainId: false,
    ...options,
  })({ timeout });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokens(client: ReturnType<typeof open>): (number | null)[] {
  return (client.value?.snapshot() ?? []).map((entry) => entry.tokens);
}

describe("known provider limits", () => {
  const OFFICIAL = "https://rpc.hyperliquid.xyz/evm";
  const OTHER = "https://other.example.test/evm";
  const fetchFn = async (): Promise<Response> => new Response("{}", { status: 200 });

  test("the official RPC keeps under its per-IP limit unless the caller sets a budget", () => {
    expect(tokens(open({ endpoints: [OFFICIAL, OTHER], fetchFn }))).toEqual([3, null]);
    expect(tokens(open({ endpoints: [OFFICIAL], fetchFn, budget: { rps: 10 } }))).toEqual([20]);
    expect(tokens(open({ endpoints: [{ url: OFFICIAL, rps: 5 }], fetchFn }))).toEqual([10]);
    expect(tokens(open({ endpoints: [OFFICIAL], fetchFn, budget: false }))).toEqual([null]);
  });
});

describe("budget buckets", () => {
  test("burst defaults to two seconds of rate, and at least one request", () => {
    expect(defaultBurst(1.5)).toBe(3);
    expect(defaultBurst(10)).toBe(20);
    expect(defaultBurst(0.2)).toBe(1);
    expect(resolveDefaultBudget({ rps: 1.5 })).toEqual({ rps: 1.5, burst: 3 });
  });

  test("a bucket starts full, refills from the clock, and never holds more than burst", () => {
    let nowMs = 0;
    const budgets = new Budgets(() => nowMs);
    budgets.configure("a", { rps: 2, burst: 2 });
    expect(budgets.remaining("a")).toBe(2);
    budgets.take("a");
    budgets.take("a");
    expect(budgets.has("a")).toBe(false);
    expect(budgets.refillMs(["a"])).toBe(500);
    nowMs += 499;
    expect(budgets.has("a")).toBe(false);
    nowMs += 1;
    expect(budgets.has("a")).toBe(true);
    nowMs += 60_000;
    expect(budgets.remaining("a")).toBe(2);
  });

  test("an endpoint without a budget is unlimited", () => {
    const budgets = new Budgets(() => 0);
    budgets.configure("a", undefined);
    for (let index = 0; index < 100; index += 1) budgets.take("a");
    expect(budgets.has("a")).toBe(true);
    expect(budgets.remaining("a")).toBeNull();
    expect(budgets.refillMs(["a"])).toBe(0);
  });

  test("refillMs reports the soonest of several spent endpoints", () => {
    const budgets = new Budgets(() => 0);
    budgets.configure("slow", { rps: 1, burst: 1 });
    budgets.configure("fast", { rps: 10, burst: 1 });
    budgets.take("slow");
    budgets.take("fast");
    expect(budgets.refillMs(["slow", "fast"])).toBe(100);
  });

  test("an endpoint budget replaces the default, and a lone burst keeps the default rate", () => {
    const fallback = { rps: 4, burst: 5 };
    expect(resolveEndpointBudget({}, fallback, "e")).toEqual(fallback);
    expect(resolveEndpointBudget({ rps: 1 }, fallback, "e")).toEqual({ rps: 1, burst: 2 });
    expect(resolveEndpointBudget({ burst: 9 }, fallback, "e")).toEqual({ rps: 4, burst: 9 });
    expect(resolveEndpointBudget({ rps: 1 }, false, "e")).toBeUndefined();
    expect(resolveEndpointBudget({}, undefined, "e")).toBeUndefined();
  });

  test.each([
    [{ endpoints: [{ transport: mockEndpoint(answers).transport, rps: 0 }] }, /endpoints\[0\]\.rps/],
    [{ endpoints: [{ transport: mockEndpoint(answers).transport, rps: 1, burst: 0.5 }] }, /endpoints\[0\]\.burst/],
    [{ endpoints: [{ transport: mockEndpoint(answers).transport, burst: 2 }] }, /burst needs an rps/],
    [{ endpoints: [mockEndpoint(answers).transport], budget: { rps: Number.NaN } }, /budget\.rps/],
  ] as [HyperevmTransportOptions, RegExp][])("invalid budgets throw (%#)", (options, message) => {
    expect(() => open(options)).toThrow(message);
  });
});

describe("routing under budgets", () => {
  test("there is no budget by default", async () => {
    const node = mockEndpoint(answers);
    const client = open({ endpoints: [node.transport], now: () => 0 });
    for (let index = 0; index < 50; index += 1) await client.request({ method: "eth_call", params: [] });
    expect(node.calls).toHaveLength(50);
    expect(tokens(client)).toEqual([null]);
  });

  test("a spent endpoint is skipped while another has budget", async () => {
    const a = mockEndpoint(answers);
    const b = mockEndpoint(answers);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a", rps: 1, burst: 2 },
        { transport: b.transport, label: "b" },
      ],
      now: () => 0,
    });
    for (let index = 0; index < 5; index += 1) await client.request({ method: "eth_call", params: [] });
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(3);
    expect(tokens(client)).toEqual([0, null]);
  });

  test("the transport budget applies to every endpoint without its own", async () => {
    const a = mockEndpoint(answers);
    const b = mockEndpoint(answers);
    const client = open({
      endpoints: [a.transport, { transport: b.transport, rps: 0.1, burst: 3 }],
      budget: { rps: 0.1, burst: 1 },
      now: () => 0,
    });
    for (let index = 0; index < 4; index += 1) await client.request({ method: "eth_call", params: [] });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(3);
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  test("budget false turns off per-endpoint budgets too", async () => {
    const a = mockEndpoint(answers);
    const client = open({ endpoints: [{ transport: a.transport, rps: 1, burst: 1 }], budget: false, now: () => 0 });
    for (let index = 0; index < 5; index += 1) await client.request({ method: "eth_call", params: [] });
    expect(a.calls).toHaveLength(5);
    expect(tokens(client)).toEqual([null]);
  });

  test("when every endpoint is spent, a call waits for the next token", async () => {
    const a = mockEndpoint(answers);
    const client = open({ endpoints: [{ transport: a.transport, rps: 50, burst: 1 }] });
    await client.request({ method: "eth_call", params: [] });
    const started = Date.now();
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(a.calls).toHaveLength(2);
  });

  test("a refill past the retry budget fails fast without a request, with the label only", async () => {
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      urls.push(String(input));
      const body = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
    };
    const client = open({
      endpoints: [{ url: "https://rpc.example.test/evm?key=SECRET", label: "keyed", rps: 0.1, burst: 1 }],
      fetchFn,
      now: () => 0,
    });
    await client.request({ method: "eth_call", params: [] });
    const started = Date.now();
    const error = await client.request({ method: "eth_call", params: [] }).catch((caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(100);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).endpoints).toEqual(["keyed"]);
    expect((error as BudgetExhaustedError).refillMs).toBe(10_000);
    expect(String((error as Error).message)).not.toContain("SECRET");
    expect(urls).toHaveLength(1);
  });

  test("an endpoint that already failed the call is tried again before a spent one is waited for", async () => {
    const a = mockEndpoint((method, seen) => {
      if (method === "eth_call" && seen === 0) throw new Error("socket hang up");
      return answers(method);
    });
    const b = mockEndpoint(answers);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b", rps: 0.1, burst: 1 },
      ],
      now: () => 0,
    });
    // A probe spends b's only token.
    await client.value?.probe();
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(a.calls).toEqual(["eth_blockNumber", "eth_call", "eth_call"]);
    expect(b.calls).toEqual(["eth_blockNumber"]);
  });

  test("a call the caller aborts while it waits for a token sends nothing", async () => {
    const a = mockEndpoint(answers);
    const client = open({ endpoints: [{ transport: a.transport, rps: 1, burst: 1 }] });
    await client.request({ method: "eth_call", params: [] });
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.request({ method: "eth_call", params: [] }, { signal: controller.signal } as never);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(500);
    expect(a.calls).toHaveLength(1);
  });

  test("instances one factory builds spend the same buckets", async () => {
    const a = mockEndpoint(answers);
    const factory = hyperevm({
      ...BASELINE,
      endpoints: [{ transport: a.transport, rps: 0.1, burst: 2 }],
      headLag: false,
      verifyChainId: false,
      now: () => 0,
    });
    const first = factory({ timeout: 1_000 });
    const second = factory({ timeout: 2_000 });
    expect(first).not.toBe(second);
    await first.request({ method: "eth_call", params: [] });
    await second.request({ method: "eth_call", params: [] });
    expect(first.value?.snapshot()[0]?.tokens).toBe(0);
    await expect(second.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});

describe("every upstream request spends a token", () => {
  test("a retry on the same endpoint spends a token", async () => {
    const a = mockEndpoint((method, seen) => {
      if (method === "eth_call" && seen === 0) throw new Error("socket hang up");
      return answers(method);
    });
    const client = open({ endpoints: [{ transport: a.transport, rps: 1, burst: 3 }], now: () => 0 });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(a.calls).toHaveLength(2);
    expect(tokens(client)).toEqual([1]);
  });

  test("chain checks spend a token, and a spent endpoint is not checked", async () => {
    const a = mockEndpoint(answers);
    const client = open({
      endpoints: [{ transport: a.transport, rps: 0.1, burst: 2 }],
      verifyChainId: true,
      now: () => 0,
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(a.calls).toEqual(["eth_chainId", "eth_call"]);
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(a.calls).toHaveLength(2);
  });

  test("a chain check that takes the last token moves the call to an endpoint with budget", async () => {
    const a = mockEndpoint(answers);
    const b = mockEndpoint(answers);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a", rps: 0.1, burst: 1 },
        { transport: b.transport, label: "b" },
      ],
      verifyChainId: true,
      now: () => 0,
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(a.calls).toEqual(["eth_chainId"]);
    expect(b.calls).toEqual(["eth_chainId", "eth_call"]);
  });

  test("head probes spend a token and skip spent endpoints instead of waiting", async () => {
    const a = mockEndpoint(answers);
    const b = mockEndpoint(answers);
    const client = hyperevm({
      ...BASELINE,
      endpoints: [
        { transport: a.transport, label: "a", rps: 0.1, burst: 1 },
        { transport: b.transport, label: "b", rps: 0.1, burst: 2 },
      ],
      headLag: { probeInterval: false },
      verifyChainId: false,
      now: () => 0,
    })({});
    await client.value?.probe();
    expect(a.calls).toEqual(["eth_blockNumber"]);
    expect(b.calls).toEqual(["eth_blockNumber"]);
    const started = Date.now();
    await client.value?.probe();
    expect(Date.now() - started).toBeLessThan(100);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(2);
    expect(client.value?.snapshot().map((entry) => entry.tokens)).toEqual([0, 0]);
  });

  test("a probe whose chain check took the last token does not send eth_blockNumber", async () => {
    const a = mockEndpoint(answers);
    const client = hyperevm({
      ...BASELINE,
      endpoints: [{ transport: a.transport, rps: 0.1, burst: 1 }],
      headLag: { probeInterval: false },
      now: () => 0,
    })({});
    await client.value?.probe();
    expect(a.calls).toEqual(["eth_chainId"]);
  });

  test("a hedge is not sent to a spent backup", async () => {
    const events: HyperevmEvent[] = [];
    const slow = mockEndpoint(async (method) => {
      await sleep(80);
      return answers(method);
    });
    const backup = mockEndpoint(answers);
    const client = open({
      endpoints: [
        { transport: slow.transport, label: "slow" },
        { transport: backup.transport, label: "backup", rps: 0.1, burst: 1 },
      ],
      hedge: { minDelay: 5, multiplier: 2 },
      onEvent: (event) => events.push(event),
    });
    // Spend the backup's token on a hedge, then check the second read is not hedged.
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(backup.calls).toHaveLength(1);
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(backup.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "hedge")).toHaveLength(1);
  });
});

describe("budgets and the breaker", () => {
  test("an ejected endpoint with budget is not used in place of a spent closed one", async () => {
    const a = mockEndpoint((method) => {
      if (method === "eth_call") throw new Error("socket hang up");
      return answers(method);
    });
    const b = mockEndpoint(answers);
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a" },
        { transport: b.transport, label: "b", rps: 0.1, burst: 1 },
      ],
      breaker: { threshold: 1 },
      now: () => 0,
    });
    // a fails and is ejected, b serves and spends its only token.
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    const error = await client.request({ method: "eth_call", params: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).endpoints).toEqual(["b"]);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  test("the all-ejected exception still needs a token", async () => {
    const a = mockEndpoint((method) => {
      if (method === "eth_call") throw new Error("socket hang up");
      return answers(method);
    });
    const client = open({
      endpoints: [{ transport: a.transport, label: "a", rps: 0.1, burst: 2 }],
      retryCount: 0,
      breaker: { threshold: 1 },
      now: () => 0,
    });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow(/socket hang up/);
    // Ejected, with one token left: the first attempt may still use it.
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow(/socket hang up/);
    expect(a.calls).toHaveLength(2);
    // Ejected and spent: nothing is sent.
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(a.calls).toHaveLength(2);
  });
});

describe("non-idempotent methods under budgets", () => {
  test("a send goes to one endpoint with budget, and is not sent once every endpoint is spent", async () => {
    const a = mockEndpoint(() => "0xa");
    const b = mockEndpoint(() => "0xb");
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a", rps: 0.1, burst: 1 },
        { transport: b.transport, label: "b", rps: 0.1, burst: 1 },
      ],
      now: () => 0,
    });
    expect(await client.request({ method: "eth_sendTransaction", params: [{}] } as never)).toBe("0xa");
    expect(await client.request({ method: "eth_sendTransaction", params: [{}] } as never)).toBe("0xb");
    await expect(client.request({ method: "eth_sendTransaction", params: [{}] } as never)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(a.calls).toEqual(["eth_sendTransaction"]);
    expect(b.calls).toEqual(["eth_sendTransaction"]);
  });

  test("a failed send does not fail over even when another endpoint has budget", async () => {
    const a = mockEndpoint(() => {
      throw new Error("socket hang up");
    });
    const b = mockEndpoint(() => "0xb");
    const client = open({
      endpoints: [
        { transport: a.transport, label: "a", rps: 1, burst: 5 },
        { transport: b.transport, label: "b", rps: 1, burst: 5 },
      ],
      now: () => 0,
    });
    await expect(client.request({ method: "eth_sendTransaction", params: [{}] } as never)).rejects.toThrow(
      /socket hang up/,
    );
    expect(b.calls).toHaveLength(0);
  });
});

describe("budgets and chain checks", () => {
  test("a token that refills between picks never sends a read to an unverified endpoint", async () => {
    // The clock moves 1ms every few reads, so a bucket spent at one check can hold a token at the next.
    // Which read crosses the boundary depends on how often the transport reads the clock, so try several rates.
    for (let readsPerMs = 2; readsPerMs <= 9; readsPerMs += 1) {
      let reads = 0;
      const node = mockEndpoint((method) => {
        if (method === "eth_chainId") throw new Error("upstream unavailable");
        return "0xdead";
      });
      const client = open({
        endpoints: [node.transport],
        verifyChainId: true,
        budget: { rps: 1_000, burst: 1 },
        breaker: false,
        retryCount: 0,
        retryDelay: 1,
        now: () => {
          reads += 1;
          return Math.floor(reads / readsPerMs);
        },
      });
      const outcomes: unknown[] = [];
      for (let index = 0; index < 30; index += 1) {
        outcomes.push(await client.request({ method: "eth_getBalance", params: [] }).catch((error: unknown) => error));
      }
      expect({ readsPerMs, sent: node.calls.filter((method) => method === "eth_getBalance") }).toEqual({
        readsPerMs,
        sent: [],
      });
      expect(outcomes).not.toContain("0xdead");
    }
  });
});
