import { describe, expect, test } from "bun:test";
import { createTransport, keccak256, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import {
  hyperevm,
  type HyperevmEndpointConfig,
  type HyperevmEvent,
  type HyperevmTransportOptions,
} from "../../src/transport/mod.ts";

interface RpcBody {
  id: number;
  method: string;
  params?: unknown;
}

interface Reply {
  status?: number;
  result?: unknown;
  error?: { code: number; message: string };
  headers?: Record<string, string>;
}

interface MockFetch {
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: { url: string; method: string }[];
}

/** A fetch that answers single JSON-RPC calls through real viem `http()`. */
function mockFetch(handler: (url: string, body: RpcBody, seen: number) => Reply): MockFetch {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as RpcBody;
    const seen = calls.filter((call) => call.url === url).length;
    calls.push({ url, method: body.method });
    const reply = handler(url, body, seen);
    const status = reply.status ?? 200;
    if (status !== 200 && reply.error === undefined)
      return new Response("rate limited", { status, headers: reply.headers });
    const payload =
      reply.error === undefined
        ? { jsonrpc: "2.0", id: body.id, result: reply.result }
        : { jsonrpc: "2.0", id: body.id, error: reply.error };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetchFn, calls };
}

interface MockEndpoint {
  transport: Transport;
  calls: { method: string }[];
}

function mockEndpoint(
  name: string,
  handler: (method: string, seen: number) => unknown | Promise<unknown>,
): MockEndpoint {
  const calls: { method: string }[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        const seen = calls.length;
        calls.push({ method });
        return handler(method, seen);
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
    // The mocks do not model eth_chainId. Chain verification has its own tests.
    verifyChainId: false,
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
}

function hang(): Promise<never> {
  return new Promise(() => {});
}

function rpcError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

/** The public label an endpoint outside the registry gets: its origin. */
function label(url: string): string {
  return new URL(url).origin;
}

const A = "https://a.example.test/evm";
const B = "https://b.example.test/evm";
const C = "https://c.example.test/evm";

/** A signed type-2 transaction shape. The bytes only need to be hex. */
const RAW_TX = "0x02f86b8203e780843b9aca00847735940082520894000000000000000000000000000000000000dead8080c0";

describe("terminal errors are healthy answers", () => {
  test("reverting eth_calls do not raise the endpoint's error EWMA", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch(() => ({ error: { code: 3, message: "execution reverted: nope" } }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    for (let index = 0; index < 5; index += 1) {
      await expect(client.request({ method: "eth_call", params: [{}, "latest"] })).rejects.toThrow(
        /execution reverted/,
      );
    }
    expect(rpc.calls).toHaveLength(5);
    expect(rpc.calls.every((call) => call.url === A)).toBe(true);
    for (const endpoint of client.value?.snapshot() ?? []) {
      expect(endpoint.methods["*"]?.error).toBe(0);
      expect(endpoint.methods.eth_call?.error ?? 0).toBe(0);
    }
    const snapshotA = client.value?.snapshot().find((endpoint) => endpoint.url === label(A));
    expect(snapshotA?.methods["*"]?.n).toBe(5);
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(5);
    expect(errors.every((event) => event.type === "error" && event.terminal === true)).toBe(true);
    expect(events.some((event) => event.type === "eject")).toBe(false);
  });

  test("an endpoint error is not terminal and still counts against the endpoint", async () => {
    const events: HyperevmEvent[] = [];
    const dead = mockEndpoint("dead", () => {
      throw new Error("socket hang up");
    });
    const live = mockEndpoint("live", () => "0x1");
    const client = open({ endpoints: [dead.transport, live.transport], onEvent: (event) => events.push(event) });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.terminal).toBe(false);
    const deadSnap = client.value?.snapshot().find((endpoint) => endpoint.url === "transport:0");
    expect(deadSnap?.methods["*"]?.error).toBeGreaterThan(0);
  });
});

describe("provider limits coded as invalid params", () => {
  test("eth_getLogs fails over a -32602 block range limit", async () => {
    const rpc = mockFetch((url) =>
      url === A ? { error: { code: -32602, message: "query exceeds max block range 1000" } } : { result: [] },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    expect(await client.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x7d0" }] })).toEqual(
      [],
    );
    expect(rpc.calls.map((call) => call.url)).toEqual([A, B]);
  });

  test("genuine invalid params stay terminal", async () => {
    const rpc = mockFetch((url) =>
      url === A
        ? { error: { code: -32602, message: "invalid argument 0: hex string without 0x prefix" } }
        : { result: [] },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    await expect(client.request({ method: "eth_getLogs", params: [{ fromBlock: "1" }] })).rejects.toThrow(
      /hex string without 0x prefix/,
    );
    expect(rpc.calls.map((call) => call.url)).toEqual([A]);
  });
});

describe("re-trying endpoints with backoff", () => {
  test("a single endpoint survives one 429 with the default retryCount", async () => {
    const rpc = mockFetch((_url, _body, seen) => (seen === 0 ? { status: 429 } : { result: "0x10" }));
    const events: HyperevmEvent[] = [];
    const client = hyperevm({
      endpoints: [A],
      fetchFn: rpc.fetchFn,
      headLag: false,
      verifyChainId: false,
      onEvent: (event) => events.push(event),
    })({ timeout: 1_000 });
    const started = Date.now();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(rpc.calls).toHaveLength(2);
    // A re-try on the same endpoint is not a failover.
    expect(events.some((event) => event.type === "failover")).toBe(false);
    // Default base is 100ms with jitter between half and all of it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  test("every endpoint is tried once before any is tried again", async () => {
    const rpc = mockFetch((_url, _body, seen) => (seen === 0 ? { status: 503 } : { result: "0x1" }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, retryCount: 3, retryDelay: 1 });
    expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    const urls = rpc.calls.map((call) => call.url);
    expect(urls).toHaveLength(3);
    // Both endpoints fail once before either is called a second time. The re-try goes to the better score.
    expect(urls.slice(0, 2)).toEqual([A, B]);
    expect([A, B]).toContain(urls[2] ?? "");
  });

  test("the caller's AbortSignal cancels a backoff", async () => {
    const rpc = mockFetch(() => ({ status: 503 }));
    const client = open({ endpoints: [A], fetchFn: rpc.fetchFn, retryDelay: 1_500 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const error = await client
      .request({ method: "eth_blockNumber" }, { signal: controller.signal })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(500);
    expect(rpc.calls).toHaveLength(1);
  });
});

describe("circuit breaker", () => {
  test("a full 429 outage does not multiply upstream requests", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch(() => ({ status: 429 }));
    const client = open({ endpoints: [A, B, C], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    for (let index = 0; index < 10; index += 1) {
      await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    }
    // Three calls trip all three breakers (9 requests). The rest send one request each.
    expect(rpc.calls).toHaveLength(16);
    const ejected = events.filter((event) => event.type === "eject");
    expect(ejected.map((event) => event.endpoint).sort()).toEqual([A, B, C].map(label));
    for (const event of ejected) expect(event).toMatchObject({ failures: 3, cooldownMs: 5_000 });
  });

  test("Retry-After ejects the endpoint for the time the provider asked for", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch((url, _body, seen) =>
      url === A && seen === 0 ? { status: 429, headers: { "retry-after": "30" } } : { result: "0x1" },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    for (let index = 0; index < 6; index += 1) expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    const eject = events.find((event) => event.type === "eject");
    expect(eject).toMatchObject({ type: "eject", endpoint: label(A), failures: 1, cooldownMs: 30_000 });
    expect(rpc.calls.filter((call) => call.url === A)).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.url === B)).toHaveLength(6);
  });

  test("a success after ejection restores the endpoint", async () => {
    let nowMs = 0;
    const events: HyperevmEvent[] = [];
    const flaky = mockEndpoint("flaky", (_method, seen) => {
      if (seen < 3) throw new Error("socket hang up");
      return "0x1";
    });
    const client = open({
      endpoints: [flaky.transport],
      retryCount: 0,
      now: () => nowMs,
      breaker: { threshold: 3, cooldown: 1_000 },
      onEvent: (event) => events.push(event),
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(client.request({ method: "eth_chainId" })).rejects.toThrow(/socket hang up/);
    }
    expect(events.filter((event) => event.type === "eject")).toHaveLength(1);
    nowMs += 1_000;
    expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    expect(events.at(-1)).toEqual({ type: "restore", endpoint: "transport:0" });
  });

  test("breaker false keeps every failover", async () => {
    const rpc = mockFetch(() => ({ status: 429 }));
    const client = open({ endpoints: [A, B, C], fetchFn: rpc.fetchFn, breaker: false });
    for (let index = 0; index < 4; index += 1) {
      await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    }
    expect(rpc.calls).toHaveLength(12);
  });
});

describe("raw transaction rebroadcast", () => {
  test("eth_sendRawTransaction fails over an endpoint error", async () => {
    const hash = keccak256(RAW_TX);
    const rpc = mockFetch((url) => (url === A ? { status: 503 } : { result: hash }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    expect(await client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).toBe(hash);
    expect(rpc.calls.map((call) => call.url)).toEqual([A, B]);
  });

  test("an already known answer on a re-send returns the transaction hash", async () => {
    const slow = mockEndpoint("slow", hang);
    const known = mockEndpoint("known", () => {
      throw rpcError("already known", -32000);
    });
    const client = open({ endpoints: [slow.transport, known.transport], timeout: 40 });
    expect(await client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).toBe(keccak256(RAW_TX));
    expect(slow.calls).toHaveLength(1);
    expect(known.calls).toHaveLength(1);
  });

  test("already known on the first send is returned to the caller", async () => {
    const known = mockEndpoint("known", () => {
      throw rpcError("already known", -32000);
    });
    const other = mockEndpoint("other", () => "0xother");
    const client = open({ endpoints: [known.transport, other.transport] });
    await expect(client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).rejects.toThrow(
      /already known/,
    );
    expect(other.calls).toHaveLength(0);
  });

  test("a node's verdict on the transaction does not fail over", async () => {
    const low = mockEndpoint("low", () => {
      throw rpcError("nonce too low: next nonce 5, tx nonce 4", -32000);
    });
    const other = mockEndpoint("other", () => "0xother");
    const client = open({ endpoints: [low.transport, other.transport] });
    await expect(client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).rejects.toThrow(
      /nonce too low/,
    );
    expect(other.calls).toHaveLength(0);
    const lowSnap = client.value?.snapshot().find((endpoint) => endpoint.url === "transport:0");
    expect(lowSnap?.methods["*"]?.error).toBe(0);
  });

  test("eth_sendRawTransactionSync fails over but cannot turn already known into a receipt", async () => {
    const down = mockEndpoint("down", () => {
      throw new Error("socket hang up");
    });
    const receipt = { transactionHash: keccak256(RAW_TX), status: "0x1" };
    const live = mockEndpoint("live", () => receipt);
    const client = open({ endpoints: [down.transport, live.transport] });
    expect(await client.request({ method: "eth_sendRawTransactionSync", params: [RAW_TX] })).toEqual(receipt);

    const slow = mockEndpoint("slow", hang);
    const known = mockEndpoint("known", () => {
      throw rpcError("already known", -32000);
    });
    const sync = open({ endpoints: [slow.transport, known.transport], timeout: 40 });
    await expect(sync.request({ method: "eth_sendRawTransactionSync", params: [RAW_TX] })).rejects.toThrow(
      /already known/,
    );
  });

  test("rebroadcastRawTransactions false sends once", async () => {
    const rpc = mockFetch((url) => (url === A ? { status: 503 } : { result: "0xhash" }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, rebroadcastRawTransactions: false });
    await expect(client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).rejects.toThrow();
    expect(rpc.calls).toHaveLength(1);
  });

  test("other non-idempotent methods stay single-attempt and raw sends are never hedged", async () => {
    const rpc = mockFetch(() => ({ status: 503 }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    await expect(client.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow();
    await expect(client.request({ method: "personal_sign", params: ["0x00", A] })).rejects.toThrow();
    expect(rpc.calls.map((call) => call.method)).toEqual(["eth_sendTransaction", "personal_sign"]);

    const slow = mockEndpoint("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "0xslow";
    });
    const fast = mockEndpoint("fast", () => "0xfast");
    const hedged = open({ endpoints: [slow.transport, fast.transport], hedge: { minDelay: 10, multiplier: 0 } });
    expect(await hedged.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).toBe("0xslow");
    expect(fast.calls).toHaveLength(0);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` with `setTimeout` dropping every timer, as when Workers cancels the invocation that set them. */
function withoutTimers<T>(fn: () => T): T {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((): number => 0) as unknown as typeof setTimeout;
  try {
    return fn();
  } finally {
    globalThis.setTimeout = original;
  }
}

describe("chain checks under concurrency", () => {
  test("a shared check stuck in a cancelled invocation does not hang other calls", async () => {
    const node = mockEndpoint("node", (method, seen) => {
      if (method === "eth_chainId") return seen === 0 ? hang() : "0x3e7";
      return "0x1";
    });
    const client = open({ endpoints: [node.transport], verifyChainId: true, timeout: 50 });
    const first = withoutTimers(() => client.request({ method: "eth_blockNumber" }));
    void first.catch(() => undefined);
    const concurrent = client.request({ method: "eth_blockNumber" });
    expect(await Promise.race([concurrent, sleep(500).then(() => "hung")])).toBe("0x1");
    const later = client.request({ method: "eth_blockNumber" });
    expect(await Promise.race([later, sleep(500).then(() => "hung")])).toBe("0x1");
  });

  test("concurrent cold calls spread across endpoints once their checks pass", async () => {
    const node = (name: string): MockEndpoint =>
      mockEndpoint(name, async (method) => {
        await sleep(method === "eth_chainId" ? 5 : 20);
        return method === "eth_chainId" ? "0x3e7" : "0x1";
      });
    const nodes = [node("a"), node("b"), node("c")];
    // Coalescing is off so that twelve identical reads each need an endpoint.
    const client = open({ endpoints: nodes.map((item) => item.transport), verifyChainId: true, coalesce: false });
    await Promise.all(Array.from({ length: 12 }, () => client.request({ method: "eth_call", params: [] })));
    const reads = nodes.map((item) => item.calls.filter((call) => call.method === "eth_call").length);
    expect(reads.reduce((sum, count) => sum + count, 0)).toBe(12);
    expect(Math.max(...reads)).toBeLessThanOrEqual(6);
  });

  test("a hedge checks an unverified backup instead of skipping it", async () => {
    const slow = mockEndpoint("slow", async (method) => {
      if (method === "eth_chainId") return "0x3e7";
      await sleep(150);
      return "0xslow";
    });
    const fast = mockEndpoint("fast", (method) => (method === "eth_chainId" ? "0x3e7" : "0xfast"));
    const client = open({
      endpoints: [slow.transport, fast.transport],
      verifyChainId: true,
      hedge: { minDelay: 5, multiplier: 2 },
    });
    const started = Date.now();
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0xfast");
    expect(Date.now() - started).toBeLessThan(120);
    expect(fast.calls.map((call) => call.method)).toEqual(["eth_chainId", "eth_call"]);
  });
});

describe("breaker interactions", () => {
  test.each([
    ["a URL string", A, label(A)],
    ["an object with url and label", { url: A, label: "keyed" }, "keyed"],
  ] as const)("a JSON-RPC rate limit on an HTTP 429 keeps its Retry-After for %s", async (_name, endpoint, id) => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch(() => ({
      status: 429,
      error: { code: -32005, message: "rate limited" },
      headers: { "retry-after": "30" },
    }));
    const client = open({ endpoints: [endpoint], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    expect(rpc.calls).toHaveLength(1);
    const eject = events.find((event) => event.type === "eject");
    expect(eject).toMatchObject({ type: "eject", endpoint: id, failures: 1 });
    // The wait counts from the response, so a millisecond may pass before the failure is recorded.
    expect(eject?.type === "eject" && eject.cooldownMs > 29_000).toBe(true);
  });

  test("an endpoint that hangs every call but answers probes is still ejected", async () => {
    const events: HyperevmEvent[] = [];
    const node = mockEndpoint("node", (method) => (method === "eth_blockNumber" ? "0x10" : hang()));
    const client = open({
      endpoints: [node.transport],
      retryCount: 0,
      timeout: 20,
      breaker: { threshold: 3 },
      onEvent: (event) => events.push(event),
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
      await client.value?.probe();
    }
    expect(events.filter((event) => event.type === "eject")).toEqual([
      expect.objectContaining({ type: "eject", endpoint: "transport:0", failures: 3 }),
    ]);
    expect(events.some((event) => event.type === "restore")).toBe(false);
  });

  test("a head probe does not end an ejection early", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch((url, body) =>
      url === A && body.method === "eth_call"
        ? { status: 429, headers: { "retry-after": "30" } }
        : { result: body.method === "eth_blockNumber" ? "0x10" : "0x1" },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    await client.value?.probe();
    expect(events.some((event) => event.type === "restore")).toBe(false);
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(rpc.calls.filter((call) => call.url === A)).toEqual([{ url: A, method: "eth_call" }]);
  });

  test("an ejected backup does not stop a re-try on the endpoint that failed once", async () => {
    const rpc = mockFetch((url, _body, seen) => {
      if (url === B) return { status: 429, headers: { "retry-after": "30" } };
      return seen === 1 ? { status: 503 } : { result: "0x1" };
    });
    const client = open({ endpoints: [B, A], fetchFn: rpc.fetchFn });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(rpc.calls.map((call) => call.url)).toEqual([B, A, A, A]);
  });
  test("a failover skips an ejected backup before checking its chain", async () => {
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as RpcBody;
      const seen = urls.filter((item) => item === url).length;
      urls.push(url);
      if (url === B)
        return seen === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } }) : hang();
      if (body.method === "eth_call" && seen === 2) return new Response("unavailable", { status: 503 });
      const result = body.method === "eth_chainId" ? "0x3e7" : "0x1";
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    const client = open({ endpoints: [B, A], fetchFn, verifyChainId: true, timeout: 1_000 });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    const started = Date.now();
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(Date.now() - started).toBeLessThan(500);
    expect(urls).toEqual([B, A, A, A, A]);
  });
});

describe("delayed failover", () => {
  test("a pick ejected by a concurrent call during retryDelay is dropped", async () => {
    const events: HyperevmEvent[] = [];
    const calls: string[] = [];
    const node =
      (name: string, handler: (method: string) => unknown, exclude: string[] = []): Transport =>
      () =>
        createTransport({
          key: name,
          name,
          type: "test",
          retryCount: 0,
          methods: { exclude },
          request: (async ({ method }: EIP1193Parameters) => {
            calls.push(`${name}:${method}`);
            return handler(method);
          }) as EIP1193RequestFn,
        });
    let failA = true;
    const a = node("a", () => {
      if (!failA) return "0xa";
      failA = false;
      throw new Error("socket hang up");
    }, ["eth_getBalance"]);
    const b = node("b", (method) => {
      if (method === "eth_getBalance") {
        throw Object.assign(new Error("rate limited"), { headers: new Headers({ "retry-after": "30" }) });
      }
      return "0xb";
    });
    const client = open({ endpoints: [a, b], retryDelay: 100, onEvent: (event) => events.push(event) });
    // P fails on A, picks B, and waits out retryDelay.
    const p = client.request({ method: "eth_call", params: [] });
    await sleep(20);
    // Q reaches only B, which asks for 30 seconds of quiet.
    await expect(client.request({ method: "eth_getBalance", params: ["0x0", "latest"] })).rejects.toThrow(
      /rate limited/,
    );
    expect(events.some((event) => event.type === "eject" && event.endpoint === "transport:1")).toBe(true);
    expect(await p).toBe("0xa");
    expect(calls).toEqual(["a:eth_call", "b:eth_getBalance", "a:eth_call"]);
    expect(events.some((event) => event.type === "restore")).toBe(false);
  });
});

describe("backoff rounds", () => {
  test("an endpoint ejected by a concurrent call during the backoff is not retried", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch((_url, body) => {
      if (body.method === "eth_chainId") return { result: "0x3e7" };
      if (body.method === "eth_getBalance") return { status: 429, headers: { "retry-after": "30" } };
      const reads = rpc.calls.filter((call) => call.method === "eth_call").length;
      return reads === 1 ? { status: 503 } : { result: "0x1" };
    });
    // Default options: chain checks, probes, p2c routing, and the breaker are all on.
    const client = hyperevm({ endpoints: [A], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) })({});
    // P gets a 503 from the only endpoint and backs off before trying it again.
    const p = client.request({ method: "eth_call", params: [] }).then(
      () => "served",
      (error: unknown) => error,
    );
    await sleep(20);
    // Q gets a 429 asking for 30 seconds while P waits.
    await expect(client.request({ method: "eth_getBalance", params: ["0x0", "latest"] })).rejects.toThrow();
    expect(events.some((event) => event.type === "eject")).toBe(true);
    const outcome = await p;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/Status: 503/);
    expect(rpc.calls.map((call) => call.method)).toEqual(["eth_chainId", "eth_call", "eth_getBalance"]);
    expect(events.some((event) => event.type === "restore")).toBe(false);
    client.value?.close();
  });

  test("a cooldown extended during a short ejection wait is not retried into", async () => {
    const events: HyperevmEvent[] = [];
    let limits = 0;
    const rpc = mockFetch((_url, body) => {
      if (body.method === "eth_chainId") return { result: "0x3e7" };
      if (body.method === "eth_getBalance") {
        limits += 1;
        return { status: 429, headers: { "retry-after": limits === 1 ? "1" : "30" } };
      }
      const reads = rpc.calls.filter((call) => call.method === "eth_call").length;
      return reads === 1 ? { status: 503 } : { result: "0x1" };
    });
    const client = hyperevm({
      endpoints: [{ url: A, label: "a" }],
      fetchFn: rpc.fetchFn,
      headLag: { probeInterval: false },
      onEvent: (event) => events.push(event),
      // Each identical call must reach an endpoint on its own, so coalescing is off.
      coalesce: false,
    })({});
    // P gets a 503 and backs off. Q asks for 1 second, so P waits that out too.
    const p = client.request({ method: "eth_call", params: [] }).then(
      () => "served",
      (error: unknown) => error,
    );
    await sleep(20);
    // Q and R are not awaited here: each waits out its own cooldown before giving up.
    const balance = (): Promise<unknown> =>
      client.request({ method: "eth_getBalance", params: ["0x0", "latest"] }).catch((error: unknown) => error);
    const q = balance();
    // While P waits, R asks for 30 seconds.
    await sleep(280);
    const r = balance();
    const outcome = await p;
    expect(await q).toBeInstanceOf(Error);
    expect(await r).toBeInstanceOf(Error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/Status: 503/);
    expect(rpc.calls.map((call) => call.method)).toEqual([
      "eth_chainId",
      "eth_call",
      "eth_getBalance",
      "eth_getBalance",
    ]);
    expect(events.some((event) => event.type === "restore")).toBe(false);
  });

  /**
   * One await point in the retry path. `victim` is the endpoint the call would retry on. A concurrent
   * `eth_getBalance`, which only the victim serves, ejects it during that await at each of `limits`.
   */
  interface AwaitCase {
    point: string;
    options: Partial<HyperevmTransportOptions>;
    /** Endpoints besides the victim. */
    others: ("first" | "checker")[];
    /** Milliseconds after the call starts, and the Retry-After the victim answers with then. */
    limits: [number, string][];
    /** Whether the victim fails the call's first read, so the call backs off on it. */
    victimFailsFirst: boolean;
    /** What the call resolves to. An Error when it must stop. */
    expected: string | typeof Error;
  }

  const cases: AwaitCase[] = [
    {
      point: "retryDelay",
      options: { retryDelay: 150 },
      others: ["first"],
      limits: [[30, "30"]],
      victimFailsFirst: false,
      expected: "0xfirst",
    },
    { point: "backoff", options: {}, others: [], limits: [[20, "30"]], victimFailsFirst: true, expected: Error },
    {
      point: "short ejection wait",
      options: {},
      others: [],
      limits: [
        [20, "0.5"],
        [250, "30"],
      ],
      victimFailsFirst: true,
      expected: Error,
    },
    {
      point: "chain check",
      options: { verifyChainId: true },
      others: ["first", "checker"],
      limits: [[30, "30"]],
      victimFailsFirst: false,
      expected: "0xfirst",
    },
  ];

  test.each(cases)("no retry lands in a cooldown opened during the $point", async (item) => {
    const events: HyperevmEvent[] = [];
    const calls: string[] = [];
    const answers = item.limits.map(([, retryAfter]) => retryAfter);
    let victimReads = 0;
    let firstReads = 0;
    const node = (
      name: string,
      handler: (method: string) => unknown,
      weight: number,
      exclude: string[] = [],
    ): HyperevmEndpointConfig => ({
      label: name,
      weight,
      transport: () =>
        createTransport({
          key: name,
          name,
          type: "test",
          retryCount: 0,
          methods: { exclude },
          request: (async ({ method }: EIP1193Parameters) => {
            calls.push(`${name}:${method}`);
            return handler(method);
          }) as EIP1193RequestFn,
        }),
    });
    const victim = node(
      "victim",
      (method) => {
        if (method === "eth_chainId") return "0x3e7";
        if (method === "eth_getBalance") {
          const retryAfter = answers.shift();
          if (retryAfter === undefined) return "0x0";
          throw Object.assign(new Error("rate limited"), { headers: new Headers({ "retry-after": retryAfter }) });
        }
        victimReads += 1;
        if (item.victimFailsFirst && victimReads === 1) throw new Error("socket hang up");
        return "0xvictim";
      },
      1,
    );
    const first = node(
      "first",
      (method) => {
        if (method === "eth_chainId") return "0x3e7";
        firstReads += 1;
        if (firstReads === 1) throw new Error("socket hang up");
        return "0xfirst";
      },
      1_000,
      ["eth_getBalance"],
    );
    // Preferred over the victim on failover. Its chain check is slow and fails.
    const checker = node(
      "checker",
      async () => {
        await sleep(80);
        throw new Error("socket hang up");
      },
      100,
      ["eth_getBalance"],
    );
    const others = { first, checker };
    const client = open({
      endpoints: [...item.others.map((name) => others[name]), victim],
      onEvent: (event) => events.push(event),
      // Each identical call must reach an endpoint on its own, so coalescing is off.
      coalesce: false,
      ...item.options,
    });
    if (item.options.verifyChainId) {
      // Verify the victim first, so the only check the call waits on is the checker's.
      answers.unshift(undefined as unknown as string);
      expect(await client.request({ method: "eth_getBalance", params: ["0x0", "latest"] })).toBe("0x0");
    }
    const before = calls.filter((call) => call === "victim:eth_call").length;
    const call = client.request({ method: "eth_call", params: [] }).then(
      (result) => result,
      (error: unknown) => error,
    );
    for (const [at] of item.limits) {
      setTimeout(() => {
        void client.request({ method: "eth_getBalance", params: ["0x0", "latest"] }).catch(() => undefined);
      }, at);
    }
    const outcome = await call;
    if (item.expected === Error) expect(outcome).toBeInstanceOf(Error);
    else expect(outcome).toBe(item.expected);
    const reads = calls.filter((entry) => entry === "victim:eth_call").length - before;
    expect(reads).toBe(item.victimFailsFirst ? 1 : 0);
    expect(events.some((event) => event.type === "eject" && event.endpoint === "victim")).toBe(true);
    expect(events.some((event) => event.type === "restore")).toBe(false);
  });
});

describe("in-flight accounting", () => {
  test("an attempt stuck in a cancelled invocation stops counting as in flight after its deadline", async () => {
    let nowMs = 0;
    const fast = mockEndpoint("fast", (_method, seen) => {
      if (seen === 3) return hang();
      nowMs += 10;
      return "0x1";
    });
    const slow = mockEndpoint("slow", () => {
      nowMs += 30;
      return "0x1";
    });
    const factory = hyperevm({
      endpoints: [fast.transport, slow.transport],
      headLag: false,
      routing: "best",
      hedge: false,
      verifyChainId: false,
      now: () => nowMs,
    });
    const first = factory({ timeout: 50 });
    for (let index = 0; index < 3; index += 1) await first.request({ method: "eth_call", params: [] });
    const abandoned = withoutTimers(() => first.request({ method: "eth_call", params: [] }));
    void abandoned.catch(() => undefined);
    await sleep(0);
    expect(first.value?.snapshot()[0]?.inflight).toBe(1);
    nowMs += 5_000;
    // A new client on the same factory shares the scoreboard the abandoned call left behind.
    const next = factory({ timeout: 50 });
    expect(next.value?.snapshot()[0]?.inflight).toBe(0);
    for (let index = 0; index < 20; index += 1) await next.request({ method: "eth_call", params: [] });
    expect(fast.calls).toHaveLength(24);
    expect(slow.calls).toHaveLength(0);
  });
});

describe("method filters", () => {
  /** A healthy endpoint whose viem `methods` filter allows only `include`. */
  function filtered(include: readonly string[]): MockEndpoint {
    const calls: { method: string }[] = [];
    const transport: Transport = () =>
      createTransport({
        key: "filtered",
        name: "filtered",
        type: "test",
        retryCount: 0,
        methods: { include: [...include] },
        request: (async ({ method }: EIP1193Parameters) => {
          calls.push({ method });
          return method === "eth_chainId" ? "0x3e7" : "0x1";
        }) as EIP1193RequestFn,
      });
    return { transport, calls };
  }

  /** Answers the chain check and head probes, and fails every read. */
  function brokenReads(): MockEndpoint {
    return mockEndpoint("broken", (method) => {
      if (method === "eth_chainId") return "0x3e7";
      if (method === "eth_blockNumber") return "0x10";
      throw new Error("socket hang up");
    });
  }

  test("head probes skip an endpoint whose filter rejects eth_blockNumber", async () => {
    const events: HyperevmEvent[] = [];
    const node = filtered(["eth_chainId", "eth_call"]);
    const backup = brokenReads();
    const client = open({
      endpoints: [node.transport, backup.transport],
      verifyChainId: true,
      onEvent: (event) => events.push(event),
    });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    for (let index = 0; index < 3; index += 1) await client.value?.probe();
    expect(events.some((event) => event.type === "eject")).toBe(false);
    for (let index = 0; index < 3; index += 1)
      expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(node.calls.map((call) => call.method)).toEqual([
      "eth_chainId",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
    ]);
  });

  test("an endpoint whose filter rejects eth_chainId is not failed by the chain check", async () => {
    const events: HyperevmEvent[] = [];
    const node = filtered(["eth_call"]);
    const backup = brokenReads();
    const client = open({
      endpoints: [node.transport, backup.transport],
      verifyChainId: true,
      onEvent: (event) => events.push(event),
    });
    for (let index = 0; index < 4; index += 1) {
      expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
      await client.value?.probe();
    }
    expect(events.filter((event) => event.type === "error" && event.endpoint === "transport:0")).toEqual([]);
    expect(node.calls.map((call) => call.method)).toEqual(["eth_call", "eth_call", "eth_call", "eth_call"]);
  });
});

describe("filter polling", () => {
  test.each([
    ["eth_getFilterChanges", ["0x1"]],
    ["eth_newFilter", [{ fromBlock: "latest" }]],
    ["eth_newBlockFilter", []],
    ["eth_newPendingTransactionFilter", []],
  ] as const)("%s is never re-sent after a lost response", async (method, params) => {
    const node = mockEndpoint("node", (_method, seen) => {
      if (seen === 0) throw new Error("socket hang up");
      return [];
    });
    const client = open({ endpoints: [node.transport] });
    await expect(client.request({ method, params: [...params] })).rejects.toThrow(/socket hang up/);
    expect(node.calls).toHaveLength(1);
  });
});

describe("caller options", () => {
  test("nonIdempotentMethods sends a listed method to one endpoint", async () => {
    const rpc = mockFetch(() => ({ status: 503 }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, nonIdempotentMethods: ["custom_mutate"] });
    await expect(client.request({ method: "custom_mutate" as "eth_call", params: [] })).rejects.toThrow();
    expect(rpc.calls).toHaveLength(1);
  });

  test("shouldThrow stops a failover the transport would otherwise make", async () => {
    const rpc = mockFetch((url) => (url === A ? { status: 503 } : { result: "0x1" }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, shouldThrow: () => true });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    expect(rpc.calls.map((call) => call.url)).toEqual([A]);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("timeout %p is rejected", (timeout) => {
    expect(() => hyperevm({ endpoints: [A], timeout })({})).toThrow(/positive number of milliseconds/);
  });

  test("an empty endpoints list says so", () => {
    expect(() => hyperevm({ endpoints: [] })({})).toThrow(/`endpoints` is empty/);
  });
});
