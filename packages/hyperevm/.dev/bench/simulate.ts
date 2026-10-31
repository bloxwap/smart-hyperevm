/**
 * Offline comparison of `hyperevm()` and viem `fallback`.
 *
 * Clocks move only when a mock endpoint handles a call, so the suite does not
 * sleep through the virtual scenarios. Each user call is preceded by
 * `value.probe()`, the same function the 4 second timer runs. Hedge uses
 * wall-clock timers because the transport schedules it with `setTimeout`.
 * @module
 */

import { createTransport, fallback, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { hyperevm, type HyperevmEvent, type ScoreConfig } from "../../src/mod.ts";

const TIP = 1_000;
const MAX_LAG = 2;
const CALLS = 120;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface PlannedCall {
  method: string;
  params?: readonly unknown[] | undefined;
}

export interface Series {
  label: string;
  requests: number;
  errors: number;
  errorRate: number;
  failovers: number;
  staleRate: number;
  median: number;
  p95: number;
  p99: number;
  busiestShare: number;
  attempts: number;
  methods: MethodSeries[];
}

export interface MethodSeries {
  method: string;
  n: number;
  errors: number;
  median: number;
  p95: number;
  staleRate: number;
}

interface Sample {
  method: string;
  latencyMs: number;
  ok: boolean;
  stale: boolean;
  failovers: number;
}

interface Clock {
  value: number;
}

interface NodeSpec {
  name: string;
  baseMs: number;
  head: number;
  /** Blocks behind the tip. The mock serves `head`; this is the stale label. */
  lag: number;
  fail: (attempt: number) => boolean;
}

export interface SimulationReport {
  calls: number;
  mix: string;
  deadFirst: Series[];
  staleHead: Series[];
  hedge: { off: HedgeSeries; on: HedgeSeries };
}

export interface HedgeSeries {
  label: string;
  requests: number;
  errors: number;
  median: number;
  p95: number;
  p99: number;
  attempts: number;
}

const MIX =
  "10-call cycle repeated 12 times: eth_call, eth_call, batched eth_call, eth_call, eth_getLogs, eth_getLogs, eth_getBlockByNumber, eth_blockNumber, eth_getBalance, eth_call. eth_getLogs costs 1.8x the base latency. A batched eth_call costs 3x.";

function workload(): PlannedCall[] {
  const cycle: PlannedCall[] = [
    { method: "eth_call" },
    { method: "eth_call" },
    { method: "eth_call", params: [{ batch: true }] },
    { method: "eth_call" },
    { method: "eth_getLogs" },
    { method: "eth_getLogs" },
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_blockNumber" },
    { method: "eth_getBalance", params: [ZERO, "latest"] },
    { method: "eth_call" },
  ];
  const calls: PlannedCall[] = [];
  while (calls.length < CALLS) calls.push(...cycle);
  return calls.slice(0, CALLS);
}

function latencyFor(baseMs: number, method: string, params: readonly unknown[] | undefined): number {
  let latency = method === "eth_getLogs" ? Math.round(baseMs * 1.8) : baseMs;
  const batched = params?.some((item) => typeof item === "object" && item !== null && "batch" in item) === true;
  if (batched) latency = Math.round(latency * 3);
  return latency;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function resultFor(spec: NodeSpec, method: string): unknown {
  if (method === "eth_blockNumber" || method === "net_listening") return hex(spec.head);
  if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") return { number: hex(spec.head) };
  return "0x1";
}

function scripted(clock: Clock, spec: NodeSpec): Transport {
  let attempt = 0;
  const transport: Transport = () =>
    createTransport({
      key: spec.name,
      name: spec.name,
      type: "test",
      retryCount: 0,
      request: (async ({ method, params }: EIP1193Parameters) => {
        attempt += 1;
        const list = Array.isArray(params) ? params : undefined;
        clock.value += latencyFor(spec.baseMs, method, list);
        if (spec.fail(attempt)) throw new Error(`${spec.name} refused the call`);
        return resultFor(spec, method);
      }) as EIP1193RequestFn,
    });
  return transport;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function rate(part: number, whole: number): number {
  if (whole === 0) return 0;
  return part / whole;
}

function methodKey(call: PlannedCall): string {
  const batched = call.params?.some((item) => typeof item === "object" && item !== null && "batch" in item) === true;
  return batched ? `${call.method} batch` : call.method;
}

function summarize(label: string, samples: Sample[], attempts: Map<string, number>): Series {
  const successes = samples.filter((sample) => sample.ok);
  const methods = new Map<string, Sample[]>();
  for (const sample of samples) {
    const group = methods.get(sample.method) ?? [];
    group.push(sample);
    methods.set(sample.method, group);
  }
  const totalAttempts = [...attempts.values()].reduce((sum, count) => sum + count, 0);
  const busiest = [...attempts.values()].reduce((max, count) => (count > max ? count : max), 0);
  return {
    label,
    requests: samples.length,
    errors: samples.length - successes.length,
    errorRate: rate(samples.length - successes.length, samples.length),
    failovers: samples.reduce((sum, sample) => sum + sample.failovers, 0),
    staleRate: rate(successes.filter((sample) => sample.stale).length, successes.length),
    median: quantile(
      samples.map((sample) => sample.latencyMs),
      50,
    ),
    p95: quantile(
      samples.map((sample) => sample.latencyMs),
      95,
    ),
    p99: quantile(
      samples.map((sample) => sample.latencyMs),
      99,
    ),
    busiestShare: rate(busiest, totalAttempts),
    attempts: totalAttempts,
    methods: [...methods.entries()].map(([method, group]) => {
      const ok = group.filter((sample) => sample.ok);
      return {
        method,
        n: group.length,
        errors: group.length - ok.length,
        median: quantile(
          group.map((sample) => sample.latencyMs),
          50,
        ),
        p95: quantile(
          group.map((sample) => sample.latencyMs),
          95,
        ),
        staleRate: rate(ok.filter((sample) => sample.stale).length, ok.length),
      };
    }),
  };
}

async function runFallback(label: string, specs: readonly NodeSpec[], ranked: boolean): Promise<Series> {
  const ordered = ranked ? await rankByPing(specs) : [...specs];
  const clock: Clock = { value: 0 };
  const transports = ordered.map((spec) => scripted(clock, spec));
  const client = fallback(transports, { retryCount: 0 })({ retryCount: 0, timeout: 10_000 });
  const attempts = new Map<string, number>();
  const samples: Sample[] = [];
  let errors = 0;
  let winner: string | null = null;
  const fallbackValue = client.value;
  if (!fallbackValue) throw new Error("fallback transport is missing its value");
  fallbackValue.onResponse((event) => {
    const name = event.transport.config.key;
    attempts.set(name, (attempts.get(name) ?? 0) + 1);
    if (event.status === "error") errors += 1;
    else winner = name;
  });
  for (const call of workload()) {
    errors = 0;
    winner = null;
    const started = clock.value;
    let ok = true;
    try {
      await client.request(requestOf(call));
    } catch {
      ok = false;
    }
    const spec = ordered.find((item) => item.name === winner);
    samples.push({
      method: methodKey(call),
      latencyMs: clock.value - started,
      ok,
      stale: ok && (spec?.lag ?? 0) > MAX_LAG,
      failovers: errors,
    });
  }
  return summarize(label, samples, attempts);
}

async function rankByPing(specs: readonly NodeSpec[]): Promise<NodeSpec[]> {
  const scored: { spec: NodeSpec; latency: number }[] = [];
  for (const spec of specs) {
    const clock: Clock = { value: 0 };
    const client = scripted(clock, spec)({ retryCount: 0, timeout: 10_000 });
    try {
      await client.request({ method: "net_listening" });
      scored.push({ spec, latency: clock.value });
    } catch {
      scored.push({ spec, latency: Number.POSITIVE_INFINITY });
    }
  }
  scored.sort((left, right) => left.latency - right.latency);
  return scored.map((item) => item.spec);
}

async function runHyperevm(
  label: string,
  specs: readonly NodeSpec[],
  routing: "p2c" | "best",
  score?: Partial<ScoreConfig>,
): Promise<Series> {
  const clock: Clock = { value: 0 };
  const transports = specs.map((spec) => scripted(clock, spec));
  const lags = new Map(specs.map((spec, index) => [`transport:${index}`, spec.lag]));
  const client = hyperevm({
    endpoints: transports,
    headLag: { probeInterval: false, maxLag: MAX_LAG },
    hedge: false,
    routing,
    retryCount: specs.length - 1,
    // The published tables measure scoring alone. The breaker would eject the dead node after three probes.
    breaker: false,
    random: mulberry32(0xdecaf),
    now: () => clock.value,
    score,
    verifyChainId: false,
  })({ timeout: 10_000 });
  const value = client.value;
  if (!value) throw new Error("hyperevm transport is missing its value");
  const attempts = new Map<string, number>();
  const samples: Sample[] = [];
  for (const call of workload()) {
    await value.probe();
    const events: HyperevmEvent[] = [];
    const stop = value.onEvent((event) => {
      events.push(event);
    });
    const started = clock.value;
    let ok = true;
    try {
      await client.request(requestOf(call));
    } catch {
      ok = false;
    } finally {
      stop();
    }
    for (const event of events) {
      if (event.type === "request") attempts.set(event.endpoint, (attempts.get(event.endpoint) ?? 0) + 1);
    }
    const success = [...events].reverse().find((event) => event.type === "success");
    const endpoint = success?.type === "success" ? success.endpoint : null;
    samples.push({
      method: methodKey(call),
      latencyMs: clock.value - started,
      ok,
      stale: ok && (lags.get(endpoint ?? "") ?? 0) > MAX_LAG,
      failovers: events.filter((event) => event.type === "failover").length,
    });
  }
  return summarize(label, samples, attempts);
}

function requestOf(call: PlannedCall): EIP1193Parameters {
  if (call.params === undefined) return { method: call.method } as EIP1193Parameters;
  return { method: call.method, params: call.params } as EIP1193Parameters;
}

function deadFirstSpecs(): NodeSpec[] {
  return [
    { name: "dead", baseMs: 12, head: 0, lag: 0, fail: () => true },
    { name: "fresh", baseMs: 40, head: TIP, lag: 0, fail: () => false },
    { name: "slow", baseMs: 160, head: TIP, lag: 0, fail: () => false },
  ];
}

function staleHeadSpecs(): NodeSpec[] {
  return [
    { name: "dead", baseMs: 12, head: 0, lag: 0, fail: () => true },
    { name: "stale", baseMs: 22, head: TIP - 8, lag: 8, fail: () => false },
    { name: "throttle", baseMs: 45, head: TIP, lag: 0, fail: (attempt) => attempt % 5 === 0 },
    { name: "healthy", baseMs: 85, head: TIP, lag: 0, fail: () => false },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hedgePass(enabled: boolean): Promise<HedgeSeries> {
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const primary: Transport = () =>
    createTransport({
      key: "primary",
      name: "primary",
      type: "test",
      retryCount: 0,
      request: (async () => {
        primaryCalls += 1;
        const stall = primaryCalls % 5 === 1;
        await sleep(stall ? 200 : 30);
        return "0x1";
      }) as EIP1193RequestFn,
    });
  const secondary: Transport = () =>
    createTransport({
      key: "secondary",
      name: "secondary",
      type: "test",
      retryCount: 0,
      request: (async () => {
        secondaryCalls += 1;
        await sleep(30);
        return "0x1";
      }) as EIP1193RequestFn,
    });
  const client = hyperevm({
    endpoints: [primary, secondary],
    headLag: false,
    routing: "best",
    hedge: enabled ? { minDelay: 40, multiplier: 2 } : false,
    retryCount: 1,
    verifyChainId: false,
  })({ timeout: 2_000 });
  const samples: number[] = [];
  let errors = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = Date.now();
    try {
      await client.request({ method: "eth_call" });
    } catch {
      errors += 1;
    }
    samples.push(Date.now() - started);
  }
  return {
    label: enabled ? "hyperevm hedge on" : "hyperevm hedge off",
    requests: 20,
    errors,
    median: quantile(samples, 50),
    p95: quantile(samples, 95),
    p99: quantile(samples, 99),
    attempts: primaryCalls + secondaryCalls,
  };
}

/** Virtual-clock scenarios plus one wall-clock hedge study. */
export async function runSimulation(): Promise<SimulationReport> {
  const dead = deadFirstSpecs();
  const stale = staleHeadSpecs();
  const deadFirst = [
    await runFallback("fallback", dead, false),
    await runHyperevm("hyperevm p2c", dead, "p2c"),
    await runHyperevm("hyperevm best", dead, "best"),
  ];
  const staleHead = [
    await runFallback("fallback", stale, false),
    await runFallback("fallback after one ping sort", stale, true),
    await runHyperevm("hyperevm p2c", stale, "p2c"),
    await runHyperevm("hyperevm best", stale, "best"),
    await runHyperevm("hyperevm p2c lagWeight 2", stale, "p2c", { lagWeight: 2 }),
    await runHyperevm("hyperevm p2c latencyMix 0.4", stale, "p2c", { latencyMix: 0.4 }),
  ];
  const hedge = {
    off: await hedgePass(false),
    on: await hedgePass(true),
  };
  return { calls: CALLS, mix: MIX, deadFirst, staleHead, hedge };
}

if (import.meta.main) {
  const report = await runSimulation();
  console.log(JSON.stringify(report, null, 2));
}
