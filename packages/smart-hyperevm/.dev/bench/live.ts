/**
 * One short live pass over the shipped HTTP registry.
 *
 * Manual. CI runs the simulation in tests/bench instead. This script exits 0
 * when the pass finishes, including when endpoints fail.
 *
 * Usage: `bun run bench:live`
 * Set BENCH_OUT to also write the JSON to a file.
 * @module
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fallback, http, type EIP1193Parameters, type Transport } from "viem";

import { hyperevm, type HyperevmEvent } from "../../src/mod.ts";
import { registryHttpEndpoints } from "../../src/registry/mod.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const TIMEOUT_MS = 4_000;

const CALLS: { method: string; params?: readonly unknown[] }[] = [
  { method: "eth_chainId" },
  { method: "eth_blockNumber" },
  { method: "eth_getBalance", params: [ZERO, "latest"] },
  { method: "eth_call", params: [{ to: ZERO, data: "0x" }, "latest"] },
  { method: "eth_getBlockByNumber", params: ["latest", false] },
  {
    method: "eth_getLogs",
    params: [{ fromBlock: "latest", toBlock: "latest", address: ZERO }],
  },
];

interface LiveSample {
  method: string;
  latencyMs: number;
  ok: boolean;
  failovers: number;
  block: number | null;
}

interface LiveSeries {
  label: string;
  requests: number;
  errors: number;
  errorRate: number;
  failovers: number;
  median: number;
  p95: number;
  staleReads: number;
  staleRate: number;
  samples: LiveSample[];
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function blockOf(method: string, result: unknown): number | null {
  if (method === "eth_blockNumber" && typeof result === "string") return Number.parseInt(result, 16);
  if (method === "eth_getBlockByNumber" && typeof result === "object" && result !== null && "number" in result) {
    const number = result.number;
    if (typeof number === "string") return Number.parseInt(number, 16);
  }
  return null;
}

async function timeFallback(transport: Transport): Promise<LiveSample[]> {
  const client = transport({ retryCount: 0, timeout: TIMEOUT_MS });
  const value = client.value;
  if (!value) throw new Error("fallback transport is missing its value");
  const samples: LiveSample[] = [];
  for (let round = 0; round < 2; round += 1) {
    for (const call of CALLS) {
      let failovers = 0;
      value.onResponse((event: { status: string }) => {
        if (event.status === "error") failovers += 1;
      });
      const started = Date.now();
      try {
        const result = await client.request(asRequest(call));
        samples.push({
          method: call.method,
          latencyMs: Date.now() - started,
          ok: true,
          failovers,
          block: blockOf(call.method, result),
        });
      } catch {
        samples.push({
          method: call.method,
          latencyMs: Date.now() - started,
          ok: false,
          failovers,
          block: null,
        });
      }
    }
  }
  return samples;
}

async function timeHyperevm(transport: Transport): Promise<LiveSample[]> {
  const client = transport({ retryCount: 0, timeout: TIMEOUT_MS });
  const value = client.value;
  if (!value || !("onEvent" in value)) throw new Error("hyperevm transport is missing onEvent");
  const samples: LiveSample[] = [];
  for (let round = 0; round < 2; round += 1) {
    for (const call of CALLS) {
      const events: HyperevmEvent[] = [];
      const stop = value.onEvent((event: HyperevmEvent) => {
        events.push(event);
      });
      const started = Date.now();
      try {
        const result = await client.request(asRequest(call));
        samples.push({
          method: call.method,
          latencyMs: Date.now() - started,
          ok: true,
          failovers: events.filter((event) => event.type === "failover").length,
          block: blockOf(call.method, result),
        });
      } catch {
        samples.push({
          method: call.method,
          latencyMs: Date.now() - started,
          ok: false,
          failovers: events.filter((event) => event.type === "failover").length,
          block: null,
        });
      } finally {
        stop();
      }
    }
  }
  return samples;
}

function asRequest(call: { method: string; params?: readonly unknown[] }): EIP1193Parameters {
  if (call.params === undefined) return { method: call.method } as EIP1193Parameters;
  return { method: call.method, params: call.params } as EIP1193Parameters;
}

function summarize(label: string, samples: LiveSample[]): LiveSeries {
  const blocks = samples.map((sample) => sample.block).filter((block): block is number => block !== null && block > 0);
  const tip = blocks.reduce((max, block) => (block > max ? block : max), 0);
  let staleReads = 0;
  let blockSamples = 0;
  for (const sample of samples) {
    if (!sample.ok || sample.block === null) continue;
    blockSamples += 1;
    if (tip - sample.block > 2) staleReads += 1;
  }
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    label,
    requests: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    failovers: samples.reduce((sum, sample) => sum + sample.failovers, 0),
    median: quantile(
      samples.map((sample) => sample.latencyMs),
      50,
    ),
    p95: quantile(
      samples.map((sample) => sample.latencyMs),
      95,
    ),
    staleReads,
    staleRate: blockSamples === 0 ? 0 : staleReads / blockSamples,
    samples,
  };
}

const urls = registryHttpEndpoints().map((endpoint) => endpoint.url);
const report = {
  ranAt: new Date().toISOString(),
  timeoutMs: TIMEOUT_MS,
  urls,
  note: "One process, two rounds of six reads. Not a load test. Stale rate counts eth_blockNumber and eth_getBlockByNumber results more than 2 blocks behind the highest block this pass observed.",
  fallback: summarize(
    "fallback",
    await timeFallback(
      fallback(
        urls.map((url) => http(url, { retryCount: 0, timeout: TIMEOUT_MS })),
        { retryCount: 0 },
      ),
    ),
  ),
  hyperevm: summarize("hyperevm", await timeHyperevm(hyperevm({ timeout: TIMEOUT_MS }))),
};

const json = JSON.stringify(report, null, 2);
console.log(json);
const out = process.env.BENCH_OUT;
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${json}\n`);
}
