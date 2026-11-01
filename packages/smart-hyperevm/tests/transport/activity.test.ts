import { afterEach, describe, expect, test } from "bun:test";
import {
  createPublicClient,
  createTransport,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { hyperEvm } from "viem/chains";

import { defaultIsActive } from "../../src/transport/_activity.ts";
import { hyperevm, type HyperevmEvent, type HyperevmTransportOptions } from "../../src/transport/mod.ts";
import { BASELINE } from "./_baseline.ts";

interface Node {
  transport: Transport;
  methods: string[];
  count: (method: string) => number;
}

function node(name: string, handler?: (method: string) => unknown | Promise<unknown>): Node {
  const methods: string[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        methods.push(method);
        const answer = handler?.(method);
        if (answer !== undefined) return answer;
        return method === "eth_chainId" ? "0x3e7" : "0x10";
      }) as EIP1193RequestFn,
    });
  return { transport, methods, count: (method) => methods.filter((item) => item === method).length };
}

/** A browser `document` reduced to what the transport reads. `show` and `hide` dispatch `visibilitychange`. */
class FakeDocument {
  visibilityState: string;
  readonly listeners = new Set<() => void>();

  constructor(state: string) {
    this.visibilityState = state;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") this.listeners.delete(listener);
  }

  show(): void {
    this.set("visible");
  }

  hide(): void {
    this.set("hidden");
  }

  set(state: string): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, "document");

function installDocument(value: unknown): void {
  Object.defineProperty(globalThis, "document", { value, configurable: true, writable: true });
}

function fakeDocument(state: string): FakeDocument {
  const document = new FakeDocument(state);
  installDocument(document);
  return document;
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "document", original);
  else Reflect.deleteProperty(globalThis, "document");
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function client(nodes: readonly Node[], options: HyperevmTransportOptions = {}) {
  return createPublicClient({
    chain: hyperEvm,
    transport: hyperevm({
      ...BASELINE,
      endpoints: nodes.map((item, index) => ({ transport: item.transport, label: `node-${index}` })),
      hedge: false,
      routing: "best",
      ...options,
    }),
  });
}

const probes = (nodes: readonly Node[]): number =>
  nodes.reduce((total, item) => total + item.count("eth_blockNumber"), 0);

describe("defaultIsActive", () => {
  test("is true without a document, as on Workers, Node, and React Native", () => {
    Reflect.deleteProperty(globalThis, "document");
    expect(defaultIsActive()).toBe(true);
  });

  test("is false only while a browser page is hidden", () => {
    const document = fakeDocument("visible");
    expect(defaultIsActive()).toBe(true);
    document.visibilityState = "hidden";
    expect(defaultIsActive()).toBe(false);
    document.visibilityState = "prerender";
    expect(defaultIsActive()).toBe(true);
  });

  test("ignores a document without visibilityState", () => {
    installDocument({ addEventListener() {}, removeEventListener() {} });
    expect(defaultIsActive()).toBe(true);
  });

  test("ignores a document without visibility listeners", () => {
    installDocument({ visibilityState: "hidden" });
    expect(defaultIsActive()).toBe(true);
  });
});

describe("hyperevm probes pause while inactive", () => {
  test("a hidden page sends no probe ticks or chain checks, and calls still run", async () => {
    fakeDocument("hidden");
    const nodes = [node("a"), node("b"), node("c")];
    const reader = client(nodes, { headLag: { probeInterval: 10 } });
    expect(await reader.request({ method: "eth_call", params: [{ to: "0x" }, "latest"] })).toBe("0x10");
    await sleep(60);
    expect(probes(nodes)).toBe(0);
    // Only the endpoint that served the call was checked. Probes would have checked the others.
    expect(nodes.map((item) => item.count("eth_chainId"))).toEqual([1, 0, 0]);
    reader.transport.close();
  });

  test("the page becoming visible runs one probe at once, and hiding it does not", async () => {
    const document = fakeDocument("hidden");
    const nodes = [node("a"), node("b")];
    const reader = client(nodes, { headLag: { probeInterval: 60_000 } });
    await reader.request({ method: "eth_chainId" });
    document.show();
    await sleep(10);
    expect(nodes.map((item) => item.count("eth_blockNumber"))).toEqual([1, 1]);
    document.hide();
    await sleep(10);
    expect(probes(nodes)).toBe(2);
    reader.transport.close();
  });

  test("switching tabs back and forth runs at most one probe per interval", async () => {
    const document = fakeDocument("visible");
    const nodes = [node("a")];
    const reader = client(nodes, { headLag: { probeInterval: 60_000 } });
    await reader.request({ method: "eth_chainId" });
    for (let index = 0; index < 20; index += 1) {
      document.hide();
      document.show();
      await sleep(index % 4 === 0 ? 5 : 0);
    }
    await sleep(10);
    expect(probes(nodes)).toBe(1);
    reader.transport.close();
  });

  test("ticks resume once the page is visible, with no event", async () => {
    const document = fakeDocument("hidden");
    const nodes = [node("a")];
    const reader = client(nodes, { headLag: { probeInterval: 10 } });
    await reader.request({ method: "eth_chainId" });
    await sleep(40);
    expect(probes(nodes)).toBe(0);
    document.visibilityState = "visible";
    await sleep(60);
    expect(probes(nodes)).toBeGreaterThan(0);
    reader.transport.close();
  });

  test("the visibility listener lives only while the probe timer runs", async () => {
    const document = fakeDocument("visible");
    const transport = hyperevm({
      ...BASELINE,
      endpoints: [{ transport: node("a").transport, label: "a" }],
      headLag: { probeInterval: 10, probeIdleTimeout: 30 },
    });
    const clients = Array.from({ length: 3 }, () => createPublicClient({ chain: hyperEvm, transport }));
    expect(document.listeners.size).toBe(0);
    await Promise.all(clients.map((item) => item.request({ method: "eth_chainId" })));
    expect(document.listeners.size).toBe(1);
    // Idle stop removes it.
    await sleep(100);
    expect(document.listeners.size).toBe(0);
    await clients[0]?.request({ method: "eth_chainId" });
    expect(document.listeners.size).toBe(1);
    clients[0]?.transport.close();
    expect(document.listeners.size).toBe(0);
  });

  test("an idle stop while hidden removes the listener on schedule", async () => {
    const document = fakeDocument("hidden");
    const nodes = [node("a")];
    const reader = client(nodes, { headLag: { probeInterval: 10, probeIdleTimeout: 30 } });
    await reader.request({ method: "eth_chainId" });
    expect(document.listeners.size).toBe(1);
    await sleep(100);
    expect(document.listeners.size).toBe(0);
    document.show();
    await sleep(10);
    expect(probes(nodes)).toBe(0);
  });

  test("no listener without a probe timer", async () => {
    const document = fakeDocument("visible");
    const off = client([node("a")], { headLag: { probeInterval: false } });
    await off.request({ method: "eth_chainId" });
    const noLag = client([node("b")], { headLag: false });
    await noLag.request({ method: "eth_chainId" });
    expect(document.listeners.size).toBe(0);
  });

  test("a custom isActive pauses and resumes ticks without a document", async () => {
    let active = false;
    const nodes = [node("a")];
    const reader = client(nodes, { headLag: { probeInterval: 10 }, isActive: () => active });
    await reader.request({ method: "eth_chainId" });
    await sleep(50);
    expect(probes(nodes)).toBe(0);
    active = true;
    await sleep(50);
    expect(probes(nodes)).toBeGreaterThan(0);
    reader.transport.close();
  });

  test("a custom isActive wins over the page's visibility", async () => {
    const document = fakeDocument("visible");
    const paused = [node("a")];
    const pausedClient = client(paused, { headLag: { probeInterval: 10 }, isActive: () => false });
    await pausedClient.request({ method: "eth_chainId" });
    document.show();
    await sleep(50);
    expect(probes(paused)).toBe(0);
    pausedClient.transport.close();

    document.visibilityState = "hidden";
    const running = [node("b")];
    const runningClient = client(running, { headLag: { probeInterval: 10 }, isActive: () => true });
    await runningClient.request({ method: "eth_chainId" });
    await sleep(50);
    expect(probes(running)).toBeGreaterThan(0);
    runningClient.transport.close();
  });

  test("an isActive that throws counts as active", async () => {
    const nodes = [node("a")];
    const reader = client(nodes, {
      headLag: { probeInterval: 10 },
      isActive: () => {
        throw new Error("no AppState");
      },
    });
    await reader.request({ method: "eth_chainId" });
    await sleep(50);
    expect(probes(nodes)).toBeGreaterThan(0);
    reader.transport.close();
  });

  test("value.probe() still probes while inactive", async () => {
    const nodes = [node("a"), node("b")];
    const reader = client(nodes, { headLag: { probeInterval: false }, isActive: () => false });
    await reader.transport.probe();
    expect(nodes.map((item) => item.count("eth_blockNumber"))).toEqual([1, 1]);
  });

  test("the resume probe skips an endpoint the breaker ejected while hidden", async () => {
    const document = fakeDocument("hidden");
    const sick = node("sick", (method) => {
      if (method === "eth_call") throw new Error("socket hang up");
      return undefined;
    });
    const healthy = node("healthy");
    const events: HyperevmEvent[] = [];
    const reader = client([sick, healthy], {
      headLag: { probeInterval: 60_000 },
      breaker: { threshold: 1, cooldown: 60_000 },
      retryCount: 1,
      onEvent: (event) => events.push(event),
    });
    expect(await reader.request({ method: "eth_call", params: [{ to: "0x" }, "latest"] })).toBe("0x10");
    expect(events.some((event) => event.type === "eject" && event.endpoint === "node-0")).toBe(true);
    document.show();
    await sleep(10);
    expect(sick.count("eth_blockNumber")).toBe(0);
    expect(healthy.count("eth_blockNumber")).toBe(1);
    reader.transport.close();
  });

  test("the resume probe checks unverified chains first and never probes a quarantined endpoint", async () => {
    const document = fakeDocument("hidden");
    const good = node("good");
    const wrong = node("wrong", (method) => (method === "eth_chainId" ? "0x1" : undefined));
    const events: HyperevmEvent[] = [];
    const reader = client([good, wrong], {
      headLag: { probeInterval: 60_000 },
      onEvent: (event) => events.push(event),
    });
    await reader.request({ method: "eth_chainId" });
    expect(wrong.methods).toEqual([]);
    document.show();
    await sleep(10);
    expect(wrong.methods).toEqual(["eth_chainId"]);
    expect(good.count("eth_blockNumber")).toBe(1);
    expect(events.some((event) => event.type === "quarantine" && event.endpoint === "node-1")).toBe(true);
    reader.transport.close();
  });

  test("a send while hidden goes to one endpoint and starts no probe", async () => {
    fakeDocument("hidden");
    const first = node("first", (method) => {
      if (method === "eth_sendTransaction") throw new Error("socket hang up");
      return undefined;
    });
    const second = node("second");
    const transport = hyperevm({
      ...BASELINE,
      endpoints: [
        { transport: first.transport, label: "first" },
        { transport: second.transport, label: "second" },
      ],
      headLag: { probeInterval: 10 },
      hedge: true,
      routing: "best",
    })({ chain: hyperEvm });
    await expect(transport.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow("socket hang up");
    await sleep(40);
    expect(first.count("eth_sendTransaction")).toBe(1);
    expect(second.methods).toEqual([]);
    expect(probes([first, second])).toBe(0);
    transport.value?.close();
  });

  test("a call while hidden honors its abort signal", async () => {
    fakeDocument("hidden");
    const slow = node("slow", (method) =>
      method === "eth_call" ? new Promise((resolve) => setTimeout(() => resolve("0x10"), 200)) : undefined,
    );
    const transport = hyperevm({
      ...BASELINE,
      endpoints: [{ transport: slow.transport, label: "slow" }],
      headLag: { probeInterval: 10 },
      retryCount: 0,
    })({ chain: hyperEvm });
    const controller = new AbortController();
    const pending = transport.request(
      { method: "eth_call", params: [{ to: "0x" }, "latest"] },
      { signal: controller.signal },
    );
    await sleep(20);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(probes([slow])).toBe(0);
    transport.value?.close();
  });
});
