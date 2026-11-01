/**
 * Probe one HTTP endpoint. A wrong chain id is a failed observation and its
 * block number is not allowed to move the cohort's best head.
 *
 * Besides liveness, the probe checks the two reads papertrade-style clients
 * lean on: a HyperCore read precompile and a 999-block `eth_getLogs`.
 * @module
 */

import {
  LOGS_RANGE_BLOCKS,
  LOGS_RANGE_PROBE,
  PRECOMPILE_PROBE,
  type ProbeObservation,
} from "../src/registry/_policy.ts";

const EXPECTED_CHAIN_ID = 999;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EMPTY_LOG_ADDRESS = "0x0000000000000000000000000000000000000001";
const MAX_BODY = 1_000_000;
/**
 * HyperCore `l1BlockNumber` read precompile (`L1Read.sol`). Takes no arguments and
 * returns the HyperCore block number as an ABI-encoded uint64, so a working node
 * answers empty calldata with a non-zero 32-byte word.
 * See https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore
 */
export const L1_BLOCK_NUMBER_PRECOMPILE = "0x0000000000000000000000000000000000000809";

export interface ProbeOptions {
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: Date | undefined;
}

interface MethodSample {
  ms: number;
  ok: boolean;
  result?: unknown;
}

/** Probe `url` and return one observation. The caller fills `lag` after the whole cohort returns. */
export async function probeEndpoint(url: string, options: ProbeOptions = {}): Promise<ProbeObservation> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const at = (options.now ?? new Date()).toISOString();
  const methods: ProbeObservation["methods"] = {};

  const chain = await call(url, "eth_chainId", [], timeoutMs, fetchImpl);
  methods.eth_chainId = { ms: chain.ms, ok: chain.ok && parseChainId(chain.result) === EXPECTED_CHAIN_ID };
  const chainIdOk = methods.eth_chainId.ok;

  const block = await call(url, "eth_blockNumber", [], timeoutMs, fetchImpl);
  const head = chainIdOk && block.ok ? parseQuantity(block.result) : null;
  const headAt = head === null ? undefined : new Date().toISOString();
  methods.eth_blockNumber = { ms: block.ms, ok: chainIdOk && block.ok && head !== null };

  const callSample = await call(url, "eth_call", [{ to: ZERO_ADDRESS, data: "0x" }, "latest"], timeoutMs, fetchImpl);
  methods.eth_call = { ms: callSample.ms, ok: chainIdOk && callSample.ok };

  const precompile = await call(
    url,
    "eth_call",
    [{ to: L1_BLOCK_NUMBER_PRECOMPILE, data: "0x" }, "latest"],
    timeoutMs,
    fetchImpl,
  );
  methods[PRECOMPILE_PROBE] = { ms: precompile.ms, ok: chainIdOk && precompile.ok && isNonZeroWord(precompile.result) };

  if (head !== null) {
    const hex = `0x${head.toString(16)}`;
    const logs = await call(
      url,
      "eth_getLogs",
      [{ address: EMPTY_LOG_ADDRESS, fromBlock: hex, toBlock: hex }],
      timeoutMs,
      fetchImpl,
    );
    methods.eth_getLogs = { ms: logs.ms, ok: chainIdOk && logs.ok && Array.isArray(logs.result) };
    // Same empty address over a full page: providers enforce range limits before they scan.
    const from = `0x${Math.max(0, head - (LOGS_RANGE_BLOCKS - 1)).toString(16)}`;
    const range = await call(
      url,
      "eth_getLogs",
      [{ address: EMPTY_LOG_ADDRESS, fromBlock: from, toBlock: hex }],
      timeoutMs,
      fetchImpl,
    );
    methods[LOGS_RANGE_PROBE] = { ms: range.ms, ok: chainIdOk && range.ok && Array.isArray(range.result) };
  } else {
    methods.eth_getLogs = { ms: 0, ok: false };
    methods[LOGS_RANGE_PROBE] = { ms: 0, ok: false };
  }

  const ok = chainIdOk && methods.eth_blockNumber?.ok === true;
  return {
    at,
    url,
    ok,
    chainIdOk,
    head: ok ? head : null,
    lag: null,
    ...(headAt ? { headAt } : {}),
    methods,
  };
}

/** HyperEVM mines about one block per second. Used only to compare heads taken at different times. */
const BLOCK_MS = 1_000;

/**
 * Set `lag` against the best head in the cohort.
 * Each head is projected forward to the latest sample, at one block per second,
 * so a node probed earlier is not marked stale for blocks mined while the pool waited.
 */
export function assignLags(observations: readonly ProbeObservation[]): ProbeObservation[] {
  const usable = observations.filter((observation) => observation.head !== null && observation.chainIdOk);
  const times = usable.map((observation) => Date.parse(observation.headAt ?? observation.at)).filter(Number.isFinite);
  const referenceMs = times.length === 0 ? null : Math.max(...times);
  const projected = (observation: ProbeObservation): number | null => {
    if (observation.head === null) return null;
    if (referenceMs === null) return observation.head;
    const at = Date.parse(observation.headAt ?? observation.at);
    const elapsed = Number.isFinite(at) ? Math.max(0, referenceMs - at) : 0;
    return observation.head + elapsed / BLOCK_MS;
  };
  const projectedHeads = usable.map(projected).filter((head): head is number => head !== null);
  const best = projectedHeads.length === 0 ? null : Math.max(...projectedHeads);
  return observations.map((observation) => {
    const head = projected(observation);
    if (head === null || best === null || !observation.chainIdOk) return { ...observation, lag: null };
    const behind = best - head;
    return { ...observation, lag: behind <= 0 ? 0 : Math.round(behind) };
  });
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapPool<T, U>(items: readonly T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

async function call(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<MethodSample> {
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = roundMs(performance.now() - started);
    if (!response.ok) return { ms, ok: false };
    const text = await response.text();
    if (text.length > MAX_BODY) return { ms, ok: false };
    const body = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) return { ms, ok: false };
    return { ms, ok: true, result: body.result };
  } catch {
    return { ms: roundMs(performance.now() - started), ok: false };
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseChainId(result: unknown): number | null {
  if (typeof result === "number" && Number.isInteger(result)) return result;
  if (typeof result !== "string") return null;
  const parsed = result.startsWith("0x") ? Number.parseInt(result, 16) : Number.parseInt(result, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A 32-byte hex word with at least one non-zero nibble. */
function isNonZeroWord(result: unknown): boolean {
  return typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result) && /[1-9a-fA-F]/.test(result.slice(2));
}

function parseQuantity(result: unknown): number | null {
  if (typeof result !== "string" || !result.startsWith("0x")) return null;
  const parsed = Number.parseInt(result, 16);
  return Number.isFinite(parsed) ? parsed : null;
}
