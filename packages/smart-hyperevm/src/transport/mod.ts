/**
 * Latency-aware JSON-RPC transport for HyperEVM.
 *
 * viem's `fallback` walks the list after a failure, and its `rank` option
 * pings on a timer. This transport orders endpoints from the calls it has
 * already made, then fails over. Once every endpoint has failed a call, it
 * backs off and tries them again while `retryCount` allows. Endpoints that
 * keep failing are ejected for a cooldown. Non-idempotent methods are never
 * retried and never hedged. Signed raw transactions are the exception: the
 * same bytes fail over on endpoint errors, since a rebroadcast cannot run twice.
 * @module
 */

import {
  createTransport,
  http,
  isHex,
  keccak256,
  webSocket,
  type Chain,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type EIP1193RequestOptions,
  type Transport,
} from "viem";

import {
  AllEndpointsFailedError,
  BudgetExhaustedError,
  ChainMismatchError,
  TimeoutError,
  TransportClosedError,
} from "../_errors.ts";
import { defaultRegistry, registryHttpEndpoints } from "../registry/_registry.ts";
import { type EndpointUrl, normalizeEndpointUrl } from "../registry/_url.ts";
import { Activity } from "./_activity.ts";
import {
  Breaker,
  type BreakerConfig,
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_MAX_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  retryAfterMs,
} from "./_breaker.ts";
import {
  type BudgetConfig,
  type BudgetOptions,
  Budgets,
  resolveDefaultBudget,
  resolveEndpointBudget,
} from "./_budget.ts";
import { type CacheOptions, type CacheStats, ReadCache, resolveCache } from "./_cache.ts";
import { Coalescer, coalesceKey, isCoalescableMethod } from "./_coalesce.ts";
import type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
import {
  isAbortError,
  isAlreadyKnownError,
  isBlockNotHeldError,
  isIdempotentMethod,
  isRebroadcastMethod,
  shouldFailover,
  toError,
} from "./_methods.ts";
import { LatestPin, type PinLatestOptions, resolvePin } from "./_pin.ts";
import { type RaceOptions, pickRacers, raceCalls, resolveRace } from "./_race.ts";
import { type ScoreConfig, defaultScoreConfig } from "./_score.ts";
import {
  DEFAULT_MAX_AHEAD,
  type RankedEndpoint,
  Scoreboard,
  blockNumberFromResult,
  parseQuantity,
} from "./_scoreboard.ts";
import { type ScorePersistence, type ScoreSnapshot, WarmStart } from "./_warmstart.ts";

export type { BudgetOptions } from "./_budget.ts";
export type { CacheOptions, CacheStats } from "./_cache.ts";
export type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
export {
  NON_IDEMPOTENT_METHODS,
  REBROADCAST_METHODS,
  isIdempotentMethod,
  isRebroadcastMethod,
  shouldFailover,
} from "./_methods.ts";
export type { PinLatestOptions } from "./_pin.ts";
export type { RaceOptions } from "./_race.ts";
export { blockNumberFromResult, parseQuantity } from "./_scoreboard.ts";
export { defaultScoreConfig, endpointScore, inflation, type MethodStat, type ScoreConfig } from "./_score.ts";
export {
  localStoragePersistence,
  type ScoreBook,
  type ScorePersistence,
  type ScoreSnapshot,
} from "./_warmstart.ts";

/** How long a head sample stays usable for lag penalties. */
const DEFAULT_STALE_MS = 30_000;

/** Blocks behind the best fresh head that are still treated as caught up. */
const DEFAULT_MAX_LAG = 2;

/** Background `eth_blockNumber` cadence. This refreshes heads. It is not the latency ranker. */
const DEFAULT_PROBE_MS = 4_000;

/** The probe timer stops after this long without a request, and restarts on the next one. */
const DEFAULT_PROBE_IDLE_MS = 60_000;

/** viem's HTTP default. Our own deadline races the child transport. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Extra attempts after the first, on idempotent methods and raw transaction rebroadcasts. */
const DEFAULT_RETRY_COUNT = 2;

/** Chain id endpoints must report when the client has no chain. */
const DEFAULT_CHAIN_ID = 999;

/** First backoff before re-trying endpoints that already failed this call, when `retryDelay` is 0. */
const DEFAULT_RETRY_BACKOFF_MS = 100;

/** Longest backoff before a re-try, and the most one call waits out ejections in total. Past it, the call stops. */
const MAX_RETRY_BACKOFF_MS = 2_000;

/** How long past its deadline an attempt still counts as in flight, in case its own cleanup was dropped. */
const INFLIGHT_GRACE_MS = 1_000;

export interface HeadLagOptions {
  /** Blocks of lag that do not change the score. Default: 2. */
  maxLag?: number | undefined;
  /**
   * Milliseconds between head probes. `false` disables the timer. Default: 4000.
   * The timer starts on the first request, not when the transport is built.
   */
  probeInterval?: number | false | undefined;
  /** Stop the probe timer after this many milliseconds without a request. `false` never stops it. Default: 60000. */
  probeIdleTimeout?: number | false | undefined;
  /** Heads older than this stop affecting the score. Default: 30000. */
  staleMs?: number | undefined;
  /**
   * Blocks a head may lead the median of the other endpoints' fresh heads.
   * A head further ahead is ignored, and its endpoint is scored as if it lagged by as much as it leads. Default: 1000.
   */
  maxAhead?: number | undefined;
}

export interface HedgeOptions {
  /** Minimum wait before a second endpoint is tried. Default: 250. */
  minDelay?: number | undefined;
  /** After three samples, hedge once the call exceeds this multiple of the tail. Default: 2. */
  multiplier?: number | undefined;
}

export interface BreakerOptions {
  /** Consecutive endpoint failures that eject an endpoint. Default: 3. */
  threshold?: number | undefined;
  /** First ejection in milliseconds. Each later ejection doubles it. Default: 5000. */
  cooldown?: number | undefined;
  /** Longest ejection in milliseconds, including a `Retry-After`. Default: 60000. */
  maxCooldown?: number | undefined;
}

export interface BatchOptions {
  /** Maximum JSON-RPC calls per HTTP request. Default: 1000, matching viem. */
  batchSize?: number | undefined;
  /** Milliseconds to wait for more calls before sending the batch. Default: 0. */
  wait?: number | undefined;
}

/** One explicit endpoint with an optional public label and weight. Give `url` or `transport`, not both. */
export interface HyperevmEndpointConfig {
  /** RPC URL. It may carry an API key in its path, query, or credentials. The key never leaves the transport. */
  url?: string | undefined;
  /** viem transport to call instead of a URL. It keeps only the `Retry-After` viem's errors carry. Prefer `url`. */
  transport?: Transport | undefined;
  /** Name used in events, snapshots, and errors. Default: the registry URL, or `scheme://host[:port]`. */
  label?: string | undefined;
  /** Routing weight above 0. Default: the registry weight, or 1. */
  weight?: number | undefined;
  /** Sustained requests per second this endpoint allows. Replaces the transport `budget`. Default: that budget. */
  rps?: number | undefined;
  /** Bucket size for `rps`, at least 1. Default: `max(1, ceil(rps * 2))`. */
  burst?: number | undefined;
}

/** A URL, a viem transport, or an {@link HyperevmEndpointConfig}. */
export type HyperevmEndpoint = string | Transport | HyperevmEndpointConfig;

/** Options for {@link hyperevm}. Every field is optional. */
export interface HyperevmTransportOptions {
  /**
   * URLs, viem transports, or endpoint configs. URLs become `http()` or `webSocket()`.
   * Explicit URLs may carry an API key. Only a public label is ever exposed.
   * Duplicate URLs or labels throw. Default: eligible HTTP endpoints from the shipped registry.
   *
   * Pass a keyed provider URL as a string or `{ url, label }`, not `http(url)`. viem drops the headers of a 429 or
   * 503 whose body is a JSON-RPC error, so only a transport built here keeps its `Retry-After` for the breaker.
   */
  endpoints?: readonly HyperevmEndpoint[] | undefined;
  /**
   * Check `eth_chainId` once per endpoint before its first call. An endpoint on another
   * chain is quarantined. Expected id: the client chain, or 999. Default: true.
   * A viem transport whose `methods` filter rejects `eth_chainId` is not checked.
   */
  verifyChainId?: boolean | undefined;
  /** Passed to viem `http()` for URL endpoints. Default: off, same as viem's `http()`. */
  batch?: boolean | BatchOptions | undefined;
  /** Replaces `fetch` for URL endpoints. Tests use this. */
  fetchFn?: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
  /** Transport key. Default: `"hyperevm"`. */
  key?: string | undefined;
  /** Transport name. Default: `"HyperEVM"`. */
  name?: string | undefined;
  /**
   * Extra attempts after the first, for idempotent methods and raw transaction rebroadcasts.
   * Each endpoint is tried once before any is tried again. Default: 2.
   */
  retryCount?: number | undefined;
  /**
   * Wait between failovers, in milliseconds. Default: 0.
   * Re-trying endpoints that already failed this call waits a jittered exponential backoff
   * from this base (100 when 0), capped at 2000, and at least any ejection left.
   */
  retryDelay?: number | undefined;
  /**
   * Per-attempt deadline in milliseconds, greater than 0. Wins over the client timeout.
   * Default: the client timeout, or 10000.
   */
  timeout?: number | undefined;
  /** Score `eth_call` and `eth_getLogs` separately. Default: true. */
  perMethod?: boolean | undefined;
  /** Deprioritize endpoints behind the best known head. Default: enabled. */
  headLag?: boolean | HeadLagOptions | undefined;
  /**
   * Head probe ticks send nothing while this returns false. Calls still run, on the scores already learned.
   * Default: in a browser, false while `document.visibilityState` is `"hidden"`; elsewhere always true.
   * In a browser the page becoming visible runs one probe at once. React Native has no document:
   * pass `() => AppState.currentState === "active"`. A hook that throws counts as active.
   */
  isActive?: (() => boolean) | undefined;
  /** Send a second idempotent read when the first is slower than usual. Default: off. */
  hedge?: boolean | HedgeOptions | undefined;
  /**
   * Send each idempotent read to the best-scored verified endpoints at once. The first answer wins, and losers
   * finish so their latency is still scored. `true` races 2. Only the first attempt races. A hedge adds to the race.
   * Every raced read costs `width` upstream requests. `false` sends each read to one endpoint. Default: on, width 2.
   */
  race?: boolean | RaceOptions | undefined;
  /**
   * Rewrite `"latest"`, given or implied, on idempotent reads to one block, and send the read only to endpoints
   * known to hold it. The block is the lowest trusted head among verified, open endpoints within `maxLag` of the
   * highest, raised to the last `eth_blockNumber` returned. A head counts however old it is, but one must be from
   * the last `freshMs`, or the tag passes through. An endpoint with no head or a lower one does not serve the
   * read. `eth_blockNumber` is answered with the same block unless `blockNumber` is false, and never goes back.
   * HyperCore precompile calls (`0x…0800` to `0x…08ff`) are not pinned: they read current HyperCore state at any
   * block. Some backends answer a state read at a block they have not reached with current state, so pinning
   * makes `eth_getLogs` consistent there but not those reads. Needs `headLag`. Default: on.
   */
  pinLatest?: boolean | PinLatestOptions | undefined;
  /**
   * Identical concurrent idempotent reads (same method and params) share one upstream request, and every caller
   * gets its result or error. Nothing is kept after it settles. Sends, non-idempotent methods, subscriptions, and
   * filters never share. Default: true.
   */
  coalesce?: boolean | undefined;
  /**
   * Answer idempotent reads from memory while the answer is within `maxStaleBlocks` (default 1) of the newest head
   * the transport knows and younger than `maxAgeMs` (default 2000). Keys read recently are re-read in the
   * background on each new head, with one `eth_blockNumber` a second finding heads while keys are hot, so the
   * next read hits memory. Reads at a block number or hash are kept for good: HyperEVM has instant finality.
   * Recent `eth_getLogs` filters keep an index of the last `logsWindow` blocks, extended by the new blocks only.
   * `eth_blockNumber` is answered from the newest head. Sends, nonces at `"latest"`, gas estimates and prices,
   * filters, subscriptions, and errors are never cached. Needs `headLag`. Best with `pinLatest`, which stamps
   * each entry with the exact block it was read at. `copyResults: false` shares answers with callers that never
   * mutate them; `immutableParams: true` reuses plans for params arrays that are never mutated. `false` sends every
   * read upstream. Default: on.
   */
  cache?: boolean | CacheOptions | undefined;
  /** `"best"` always uses the lowest score. `"p2c"` draws two endpoints and keeps the better one. Default: `"p2c"`. */
  routing?: "best" | "p2c" | undefined;
  /** Extra methods that must not be retried or hedged. */
  nonIdempotentMethods?: readonly string[] | undefined;
  /**
   * Fail over `eth_sendRawTransaction` and `eth_sendRawTransactionSync` on endpoint errors.
   * The same signed bytes have the same hash, and the nonce stops a second execution.
   * They are never hedged. On a re-send, an "already known" answer returns the hash. Default: true.
   */
  rebroadcastRawTransactions?: boolean | undefined;
  /**
   * Eject an endpoint after consecutive failures, or for a `Retry-After`. Routing skips ejected
   * endpoints unless all are ejected, and a failed call does not fail over into one. Default: enabled.
   */
  breaker?: boolean | BreakerOptions | undefined;
  /**
   * Request budget for every endpoint without its own `rps`: a token bucket refilled at `rps`, holding `burst`.
   * Every upstream request spends a token, probes and chain checks included. Routing skips a spent endpoint
   * while another has budget. When none does, a call waits for the next token within the 2 second retry budget,
   * or throws `BudgetExhaustedError`. `false` turns off every budget, per-endpoint ones too. Default: none, except
   * that the official RPC (`https://rpc.hyperliquid.xyz/evm`) keeps under its per-IP limit at 1.5 rps, burst 3.
   */
  budget?: BudgetOptions | false | undefined;
  /**
   * Return true to stop failover, matching viem `fallback`'s `shouldThrow`.
   * Terminal errors (reverts, invalid params, aborts) already stop failover.
   */
  shouldThrow?: ((error: Error) => boolean) | undefined;
  /** Called for routing events. Exceptions are swallowed. */
  onEvent?: ((event: HyperevmEvent) => void) | undefined;
  /**
   * Warm-start scores from storage. `load` runs once, on the instance's first request, and `save` runs at most every
   * `saveInterval` and on `close()`. A load still pending at the first pick lands later, so it never delays or fails
   * a call. Load and save errors fire a `persist` event. Use {@link localStoragePersistence} in a browser. Default: off.
   */
  persist?: ScorePersistence | undefined;
  /** Overrides for the latency score. Defaults live in {@link defaultScoreConfig}. */
  score?: Partial<ScoreConfig> | undefined;
  /** Clock used for latency samples. Tests inject this. */
  now?: (() => number) | undefined;
  /** Source of randomness for power-of-two-choices. Default: `Math.random`. */
  random?: (() => number) | undefined;
}

/** Extra fields on the transport value, beside viem's config. */
export interface HyperevmTransportValue {
  /** Subscribe to routing events. Returns an unsubscribe function. */
  onEvent: (listener: (event: HyperevmEvent) => void) => () => void;
  /** Current scores, heads, and in-flight counts. `score` is for `method`. Default: `"eth_call"`. */
  snapshot: (method?: string) => readonly EndpointSnapshot[];
  /**
   * Learned latency, tail, and error books by endpoint label, as JSON to store. Heads, breaker state, and chain
   * checks are left out, so a new session re-establishes them.
   */
  scores: () => ScoreSnapshot;
  /**
   * Seed books that have no samples yet from a {@link ScoreSnapshot} or its JSON, which may come from untrusted storage.
   * Unknown endpoints, invalid books, and books older than `persist.maxAge` are ignored, and values are clamped.
   * A seeded book counts as at most two samples, and the endpoint's first live sample replaces it.
   * True when a book was seeded.
   */
  restoreScores: (snapshot: unknown) => boolean;
  /** Endpoints this transport was built with. `id` and `url` are the public label. */
  endpoints: readonly { id: string; url: string; weight: number }[];
  /**
   * Probe every endpoint's head once.
   * The background timer calls this on `probeInterval`. A failed probe updates liveness and does not write the latency EWMA.
   */
  probe: () => Promise<void>;
  /** Read cache hit, miss, and refresh counts, and its size. Zeros when `cache` is off. */
  cacheStats: () => CacheStats;
  /**
   * Stop the probe timer and reject later requests with `TransportClosedError`. Calls already in flight finish.
   * Calling it again does nothing.
   *
   * One `hyperevm()` factory shares a single instance across instantiations with the same timeout,
   * retryCount and chain id, so closing it closes every client built that way.
   * The next instantiation after `close()` builds a fresh instance.
   */
  close: () => void;
}

interface ResolvedHeadLag {
  enabled: boolean;
  maxLag: number;
  probeInterval: number | false;
  probeIdleTimeout: number | false;
  staleMs: number;
  maxAhead: number;
}

interface ResolvedHedge {
  enabled: boolean;
  minDelay: number;
  multiplier: number;
}

interface BuiltEndpoint {
  /** Public label. The real URL lives only inside `request`. */
  id: string;
  /** Same as `id`. */
  url: string;
  weight: number;
  request: (args: { method: string; params?: unknown }, options?: { signal?: AbortSignal }) => Promise<unknown>;
  supports: (method: string) => boolean;
  /** Milliseconds a recent rate-limited HTTP response asked for in `Retry-After`. Reading it clears it. */
  retryAfter: () => number;
  /** Undefined when the endpoint is unlimited. */
  budget: BudgetConfig | undefined;
}

interface Inflight {
  promise: Promise<unknown>;
  cancel: () => void;
  cancelled: () => boolean;
}

/** Cached `eth_chainId` verdict for one endpoint. */
interface ChainGate {
  verified: boolean;
  /** Set once the endpoint reported another chain. Permanent. */
  mismatch: ChainMismatchError | undefined;
  /** Check in flight. Concurrent callers share it. */
  pending: Promise<Error | undefined> | undefined;
}

function resolveHeadLag(value: boolean | HeadLagOptions | undefined): ResolvedHeadLag {
  if (value === false) {
    return {
      enabled: false,
      maxLag: DEFAULT_MAX_LAG,
      probeInterval: false,
      probeIdleTimeout: DEFAULT_PROBE_IDLE_MS,
      staleMs: DEFAULT_STALE_MS,
      maxAhead: DEFAULT_MAX_AHEAD,
    };
  }
  const options = value === true || value === undefined ? {} : value;
  return {
    enabled: true,
    maxLag: options.maxLag ?? DEFAULT_MAX_LAG,
    probeInterval: options.probeInterval === undefined ? DEFAULT_PROBE_MS : options.probeInterval,
    probeIdleTimeout: options.probeIdleTimeout === undefined ? DEFAULT_PROBE_IDLE_MS : options.probeIdleTimeout,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    maxAhead: options.maxAhead ?? DEFAULT_MAX_AHEAD,
  };
}

function resolveBreaker(value: boolean | BreakerOptions | undefined): BreakerConfig {
  const options = typeof value === "object" ? value : {};
  return {
    enabled: value !== false,
    threshold: options.threshold ?? DEFAULT_BREAKER_THRESHOLD,
    cooldownMs: options.cooldown ?? DEFAULT_BREAKER_COOLDOWN_MS,
    maxCooldownMs: options.maxCooldown ?? DEFAULT_BREAKER_MAX_COOLDOWN_MS,
  };
}

function resolveHedge(value: boolean | HedgeOptions | undefined): ResolvedHedge {
  if (!value) return { enabled: false, minDelay: 250, multiplier: 2 };
  const options = value === true ? {} : value;
  return {
    enabled: true,
    minDelay: options.minDelay ?? 250,
    multiplier: options.multiplier ?? 2,
  };
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function supportsMethod(
  methods: { include?: readonly string[] | undefined; exclude?: readonly string[] | undefined } | undefined,
  method: string,
): boolean {
  if (!methods) return true;
  if (methods.include) return methods.include.includes(method);
  if (methods.exclude) return !methods.exclude.includes(method);
  return true;
}

/**
 * Budgets for providers with a known per-IP limit, used when neither the endpoint nor the transport sets one.
 * The official RPC allows about 100 requests a minute.
 */
const KNOWN_BUDGETS: ReadonlyMap<string, BudgetConfig> = new Map([
  ["https://rpc.hyperliquid.xyz/evm", { rps: 1.5, burst: 3 }],
]);

/** Registry weight for a normalized URL. A URL outside the registry weighs 1. */
function weightFor(url: string, explicit: boolean): number {
  const found = registryHttpEndpoints().find((endpoint) => endpoint.url === url);
  if (!found) return 1;
  if (explicit) return found.weight > 0 ? found.weight : 1;
  return found.weight;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

const unlinked = (): void => undefined;

const noProgress = (): void => undefined;

/** A call every endpoint may serve. */
const NO_BAR: ReadonlySet<string> = new Set();

/** Forwards an abort from `signal` to `controller`. Returns a function that removes the listener from `signal`. */
function linkAbort(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return unlinked;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return unlinked;
  }
  const onAbort = (): void => {
    controller.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

/** Cache key for instances one factory shares. Inputs that change routing get separate instances. */
function sharedKey(timeout: number, retryCount: number, chain: Chain | undefined): string {
  return `${timeout}:${retryCount}:${chain?.id ?? ""}`;
}

/**
 * viem `Transport` for HyperEVM (chain id 999).
 *
 * ```ts
 * import { createPublicClient } from "viem";
 * import { hyperEvm } from "viem/chains";
 * import { hyperevm } from "@bloxwap/smart-hyperevm";
 *
 * const client = createPublicClient({
 *   chain: hyperEvm,
 *   transport: hyperevm(),
 * });
 * ```
 */
export function hyperevm(options: HyperevmTransportOptions = {}): Transport<"hyperevm", HyperevmTransportValue> {
  const headLag = resolveHeadLag(options.headLag);
  const hedge = resolveHedge(options.hedge);
  const raceRivals = resolveRace(options.race);
  const routing = options.routing ?? "p2c";
  const perMethod = options.perMethod ?? true;
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? Math.random;
  const extraNonIdempotent = options.nonIdempotentMethods ?? [];
  // viem instantiates the transport once per client. Sharing keeps per-request clients
  // from multiplying probe timers or resetting learned scores.
  const shared = new Map<string, ReturnType<Transport<"hyperevm", HyperevmTransportValue>>>();
  const rebroadcastRaw = options.rebroadcastRawTransactions ?? true;
  const breakerConfig = resolveBreaker(options.breaker);
  const pinConfig = resolvePin(options.pinLatest);
  const coalesce = options.coalesce ?? true;
  const cacheConfig = resolveCache(options.cache);
  // Per factory, not per instance: clients with another timeout still spend the same provider limit.
  const budgets = new Budgets(now);

  return (parameters: {
    account?: unknown;
    chain?: Chain | undefined;
    pollingInterval?: number | undefined;
    retryCount?: number | undefined;
    timeout?: number | undefined;
  }) => {
    const timeout = options.timeout ?? parameters.timeout ?? DEFAULT_TIMEOUT_MS;
    // viem reads a 0 timeout as none. Here it would fail every attempt on the next tick.
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`hyperevm() timeout must be a positive number of milliseconds, got ${timeout}.`);
    }
    const retryCount = options.retryCount ?? parameters.retryCount ?? DEFAULT_RETRY_COUNT;
    const retryDelay = options.retryDelay ?? 0;
    const key = sharedKey(timeout, retryCount, parameters.chain);
    const existing = shared.get(key);
    if (existing) return existing;
    const retryBackoff = retryDelay > 0 ? retryDelay : DEFAULT_RETRY_BACKOFF_MS;
    const breaker = new Breaker(breakerConfig, now);
    const built = buildEndpoints(options, parameters.chain, timeout);
    if (built.length === 0) {
      throw new Error(
        options.endpoints === undefined
          ? "hyperevm() requires at least one endpoint. The registry has none eligible."
          : "hyperevm() requires at least one endpoint. `endpoints` is empty.",
      );
    }
    for (const endpoint of built) budgets.configure(endpoint.id, endpoint.budget);
    const verifyChainId = options.verifyChainId ?? true;
    const expectedChainId = parameters.chain?.id ?? DEFAULT_CHAIN_ID;
    // A child whose `methods` filter rejects `eth_chainId` cannot be checked. Its filter is the caller's choice.
    const gates = new Map<string, ChainGate>(
      built.map((endpoint) => [
        endpoint.id,
        { verified: !verifyChainId || !endpoint.supports("eth_chainId"), mismatch: undefined, pending: undefined },
      ]),
    );
    const quarantined = (id: string): boolean => gates.get(id)?.mismatch !== undefined;
    const board = new Scoreboard(
      built.map((endpoint, index) => ({
        id: endpoint.id,
        url: endpoint.url,
        weight: endpoint.weight,
        index,
        supports: (method: string): boolean => !quarantined(endpoint.id) && endpoint.supports(method),
      })),
      {
        perMethod,
        headLag: headLag.enabled,
        maxLag: headLag.maxLag,
        staleMs: headLag.staleMs,
        maxAhead: headLag.maxAhead,
        config: { ...defaultScoreConfig, ...options.score },
        now,
        ejected: (id: string): boolean => breaker.isOpen(id),
        spent: (id: string): boolean => !budgets.has(id),
      },
    );
    /** True when `id` may serve `method` now: chain verified, not quarantined, not ejected, method supported. */
    const servable = (id: string, method: string): boolean =>
      gates.get(id)?.verified === true &&
      !quarantined(id) &&
      !breaker.isOpen(id) &&
      byId.get(id)?.supports(method) === true;
    // Without head tracking there are no heads to pin to, so the whole feature stays out of the way.
    const pin = new LatestPin(
      { ...pinConfig, enabled: pinConfig.enabled && headLag.enabled },
      { heads: (maxAgeMs: number) => board.heads(maxAgeMs), maxLag: headLag.maxLag, servable },
    );
    const listeners = new Set<(event: HyperevmEvent) => void>();
    // A joined call gives another call's request one attempt deadline, as it would give an endpoint of its own, plus
    // a grace for the failover that follows a timed-out attempt. send() moves it out each time it starts an attempt
    // or a wait, so a failover keeps its joined callers. A request stuck in a cancelled invocation never does.
    const coalescer = new Coalescer(timeout + Math.min(timeout, INFLIGHT_GRACE_MS));

    const emit = (event: HyperevmEvent): void => {
      try {
        options.onEvent?.(event);
      } catch (error) {
        void error;
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          void error;
        }
      }
    };

    const byId = new Map(built.map((endpoint) => [endpoint.id, endpoint]));
    /** Endpoints outside `holders`, which a pinned read must not reach. None when nothing was pinned. */
    const barredFrom = (holders: ReadonlySet<string> | undefined): ReadonlySet<string> =>
      holders === undefined
        ? NO_BAR
        : new Set(built.filter((endpoint) => !holders.has(endpoint.id)).map((endpoint) => endpoint.id));
    const warm = new WarmStart(board, {
      persistence: options.persist,
      ids: built.map((endpoint) => endpoint.id),
      latencyCapMs: timeout,
      loadTimeoutMs: timeout,
      now,
      emit,
    });

    /**
     * A healthy answer, including a terminal error, closes the circuit.
     * A head probe or chain check (`call` false) cannot end an ejection early or clear a streak that holds a
     * failed call: a node that rate-limits or hangs expensive reads can still answer `eth_blockNumber`.
     */
    const closeCircuit = (endpoint: RankedEndpoint, call: boolean): void => {
      if (!call && breaker.isOpen(endpoint.id)) return;
      if (breaker.success(endpoint.id, !call)) emit({ type: "restore", endpoint: endpoint.url });
    };

    const openCircuit = (endpoint: RankedEndpoint, error: Error, call: boolean): void => {
      // viem drops the headers of an HTTP 429 that carries a JSON-RPC error, so the endpoint keeps its own copy.
      const asked = Math.max(retryAfterMs(error, Date.now()), byId.get(endpoint.id)?.retryAfter() ?? 0);
      const ejection = breaker.failure(endpoint.id, asked, !call);
      if (!ejection) return;
      emit({
        type: "eject",
        endpoint: endpoint.url,
        failures: ejection.failures,
        cooldownMs: ejection.cooldownMs,
        error,
      });
    };

    /**
     * Resolve to undefined once `endpoint` has reported the expected chain id, or to the reason it cannot serve yet.
     * The check bypasses `start()`, so it never writes a latency sample. A failed check counts as a failed probe
     * (liveness only) and is retried on the next call. A wrong chain quarantines the endpoint for good.
     *
     * Concurrent callers share one check, but each waits under its own deadline. On Workers the invocation that
     * started the check can end and take its I/O and timer with it, so the shared promise may never settle.
     * A caller whose deadline passes drops the stuck check, and the next caller starts a fresh one.
     */
    const checkChain = (endpoint: BuiltEndpoint): Promise<Error | undefined> => {
      const gate = gates.get(endpoint.id);
      if (!gate || gate.verified) return Promise.resolve(undefined);
      if (gate.mismatch) return Promise.resolve(gate.mismatch);
      const pending = gate.pending ?? startCheck(endpoint, gate);
      return withDeadline(pending, timeout).catch((error: unknown): Error => {
        if (gate.pending === pending) gate.pending = undefined;
        return toError(error);
      });
    };

    /** Send one `eth_chainId` for `endpoint` and record it as the gate's shared check. */
    const startCheck = (endpoint: BuiltEndpoint, gate: ChainGate): Promise<Error | undefined> => {
      const started = now();
      budgets.take(endpoint.id);
      const pending = withDeadline(endpoint.request({ method: "eth_chainId" }), timeout).then(
        (result): Error | undefined => {
          const chainId = parseQuantity(result);
          if (chainId === expectedChainId) {
            gate.verified = true;
            closeCircuit(endpoint, false);
            return undefined;
          }
          if (chainId === null) return new Error(`${endpoint.url} returned no chain id.`);
          gate.mismatch = new ChainMismatchError(endpoint.url, expectedChainId, chainId);
          emit({ type: "quarantine", endpoint: endpoint.url, chainId, expected: expectedChainId });
          return gate.mismatch;
        },
        (error: unknown): Error => {
          const wrapped = toError(error);
          const latencyMs = Math.max(0, now() - started);
          const terminal = !shouldFailover(wrapped);
          board.failure(endpoint.id, "eth_chainId", latencyMs, false, timeout);
          emit({ type: "error", endpoint: endpoint.url, method: "eth_chainId", latencyMs, error: wrapped, terminal });
          // A 429 or outage on the check is the endpoint failing, so it counts toward ejection like any call.
          if (!terminal) openCircuit(endpoint, wrapped, false);
          return wrapped;
        },
      );
      gate.pending = pending;
      void pending.finally(() => {
        if (gate.pending === pending) gate.pending = undefined;
      });
      return pending;
    };

    /**
     * `board.pick` when the pick has passed its chain check. Otherwise a promise that settles once the check does,
     * to true when it failed. The caller then picks again, so a verified pick is always synchronous and concurrent
     * calls see each other's in-flight counts: cold calls that all waited on one check spread out afterwards.
     * A failed check excludes the endpoint for this call and its reason joins `errors`, so it never costs an attempt.
     * With `skipEjected`, an ejected pick yields undefined before any check. The caller sets it unless the
     * availability exception applies.
     */
    const pickVerified = (
      method: string,
      exclude: Set<string>,
      mode: "best" | "p2c",
      parent: AbortSignal | undefined,
      errors: Error[],
      skipEjected: boolean,
    ): RankedEndpoint | undefined | Promise<boolean> => {
      const endpoint = board.pick(method, exclude, mode, random);
      if (!endpoint) {
        if (errors.length === 0) {
          for (const gate of gates.values()) if (gate.mismatch) errors.push(gate.mismatch);
        }
        return undefined;
      }
      if (skipEjected && breaker.isOpen(endpoint.id)) return undefined;
      const target = byId.get(endpoint.id);
      // A spent pick is not checked. The caller waits for a token and picks again.
      if (!target || gates.get(endpoint.id)?.verified !== false || !budgets.has(endpoint.id)) return endpoint;
      return untilAborted(checkChain(target), parent).then((reason) => {
        if (!reason) return false;
        exclude.add(endpoint.id);
        errors.push(reason);
        return true;
      });
    };

    const start = (
      endpoint: RankedEndpoint,
      method: string,
      params: unknown,
      parent: AbortSignal | undefined,
      hedged: boolean,
      sampleLatency: boolean,
    ): Inflight => {
      const state = { ignore: false, timedOut: false };
      const controller = new AbortController();
      const unlink = linkAbort(controller, parent);
      const timer = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, timeout);
      unrefTimer(timer as ReturnType<typeof setInterval>);
      const target = byId.get(endpoint.id);
      if (!target) throw new Error(`Unknown HyperEVM endpoint: ${endpoint.id}`);
      // Shared instances outlive the invocation that started an attempt, so the count expires on its own.
      const end = board.begin(endpoint.id, timeout + INFLIGHT_GRACE_MS);
      budgets.take(endpoint.id);
      emit({ type: "request", endpoint: endpoint.url, method });
      const started = now();
      // The child sees the caller's signal only. A private AbortController would
      // change viem's HTTP batch key on every call, so batches would never form.
      // The deadline below still fails the attempt over when the child ignores the signal.
      const requestPromise = Promise.resolve().then(() =>
        target.request({ method, params }, parent ? { signal: parent } : undefined),
      );
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(abortError(controller.signal));
        if (controller.signal.aborted) {
          fail();
          return;
        }
        controller.signal.addEventListener("abort", fail, { once: true });
      });
      const abortSettled = abortPromise.catch((error: unknown) => error);
      const promise = Promise.race([
        requestPromise.then(
          (result) => ({ kind: "result" as const, result, error: undefined }),
          (error: unknown) => ({ kind: "error" as const, result: undefined, error }),
        ),
        abortSettled.then((error) => ({ kind: "abort" as const, result: undefined, error })),
      ])
        .then((outcome) => {
          const latencyMs = Math.max(0, now() - started);
          if (outcome.kind === "result") {
            if (!state.ignore) {
              board.success(endpoint.id, method, latencyMs, sampleLatency);
              const block = blockNumberFromResult(method, outcome.result, params);
              if (block !== null && headLag.enabled) {
                const head = board.noteHead(endpoint.id, block);
                emit({
                  type: "head",
                  endpoint: endpoint.url,
                  head: block,
                  best: head.best,
                  lag: head.lag,
                  trusted: head.trusted,
                });
                cache?.headChanged();
              }
              emit({ type: "success", endpoint: endpoint.url, method, latencyMs, hedged });
              closeCircuit(endpoint, sampleLatency);
            }
            return outcome.result;
          }
          const wrapped = state.timedOut && !state.ignore ? new TimeoutError(timeout) : toError(outcome.error);
          const callerAbort = parent?.aborted === true || isAbortError(wrapped);
          // A method the child's filter rejects never left the process, so it says nothing about the endpoint.
          if (!state.ignore && !callerAbort && target.supports(method) && isBlockNotHeldError(wrapped)) {
            // A block or two behind is not sick, and probes already score the lag. The call fails over.
            emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal: false });
          } else if (!state.ignore && !callerAbort && target.supports(method)) {
            // A terminal error is the endpoint answering about the call. It is not sick.
            const terminal = !shouldFailover(wrapped);
            if (terminal) {
              board.success(endpoint.id, method, latencyMs, sampleLatency);
            } else {
              board.failure(endpoint.id, method, latencyMs, sampleLatency, timeout);
            }
            emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal });
            if (terminal) closeCircuit(endpoint, sampleLatency);
            else openCircuit(endpoint, wrapped, sampleLatency);
          }
          throw wrapped;
        })
        .finally(() => {
          clearTimeout(timer);
          unlink();
          if (!controller.signal.aborted) controller.abort();
          end();
        });
      return {
        promise,
        cancelled: (): boolean => state.ignore,
        cancel(): void {
          state.ignore = true;
          clearTimeout(timer);
          controller.abort();
        },
      };
    };

    /**
     * `barred` endpoints never serve this call: a pinned read leaves out the endpoints not known to hold its block.
     * They stay in `exclude` for every round, so `exclude.size > barred.size` means an endpoint failed this call.
     * `progress` hears of each attempt and wait, so callers that joined a shared send keep waiting through them.
     * A `background` read (a cache refresh) is never raced or hedged: nobody waits on it, so it costs one request.
     */
    const send = async (
      method: string,
      params: unknown,
      parent: AbortSignal | undefined,
      idempotent: boolean,
      rebroadcast: boolean,
      barred: ReadonlySet<string>,
      progress: (waitMs?: number) => void = noProgress,
      background = false,
    ): Promise<unknown> => {
      const pause = (ms: number): Promise<void> => {
        progress(ms);
        return delay(ms, parent);
      };
      const exclude = new Set<string>(barred);
      const errors: Error[] = [];
      const retries = idempotent || rebroadcast;
      // A race takes the best endpoints in score order, so its lead is never a p2c draw.
      const racing = idempotent && raceRivals > 0 && !background;
      const attempts = retries ? retryCount + 1 : 1;
      // The availability exception: when every candidate is ejected before the first attempt, that attempt may
      // still use one. Nothing else is ever dispatched to an endpoint ejected at dispatch time.
      const opening = board.pick(method, exclude, "best", random);
      const lastResort = opening !== undefined && breaker.isOpen(opening.id);
      let previous: RankedEndpoint | undefined;
      let round = 0;
      // Time spent waiting out ejections and budget refills together. It never passes MAX_RETRY_BACKOFF_MS.
      let ejectionWaitMs = 0;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let wait = attempt > 0 ? retryDelay : 0;
        let mode = attempt === 0 && !racing ? routing : "best";
        let allowEjected = attempt === 0 && lastResort;
        let newRound = false;
        let exhausted: BudgetExhaustedError | undefined;
        let endpoint: RankedEndpoint | undefined;
        // Every await below (chain check, retryDelay, budget refill, backoff, ejection wait) is followed by a fresh
        // pick, so the breaker is judged as it is at dispatch. The pick that returns is synchronous, so `start()`
        // counts it in flight and spends its token before any other call picks.
        for (;;) {
          const picked = pickVerified(method, exclude, mode, parent, errors, !allowEjected);
          if (picked instanceof Promise) {
            progress();
            // After a failed check an ejected endpoint is not checked next, so a storm costs one check per call.
            if (await picked) allowEjected = false;
            continue;
          }
          if (picked && wait > 0) {
            await pause(wait);
            wait = 0;
            continue;
          }
          if (picked && budgets.has(picked.id)) {
            // A token refilled since pickVerified saw the bucket spent, so the pick skipped its chain check.
            // Go back through the gate rather than send to an endpoint that never passed it.
            if (gates.get(picked.id)?.verified === false) continue;
            endpoint = picked;
            break;
          }
          if (picked) {
            // Every candidate is out of budget. Wait for the first token while the call's 2 second budget allows.
            const spent = spentPeers(picked, method, exclude);
            // At least 1ms, so a wait always draws on the call's budget.
            const refillMs = Math.max(1, budgets.refillMs(spent));
            if (ejectionWaitMs + refillMs <= MAX_RETRY_BACKOFF_MS) {
              ejectionWaitMs += refillMs;
              await pause(refillMs);
              continue;
            }
            exhausted = new BudgetExhaustedError(spent, refillMs);
            // Endpoints that already failed this call may still have budget. Otherwise stop below the limit.
            if (exclude.size === barred.size || newRound) break;
          }
          if (exclude.size > barred.size && !newRound) {
            // Every usable endpoint failed this call, or failed its chain check. Go back to them after a backoff.
            exclude.clear();
            for (const id of barred) exclude.add(id);
            // Stop now when the round could only wait out a longer ejection. The pick after the wait checks again.
            const candidate = board.pick(method, exclude, "best", random);
            if (!candidate || ejectionWaitMs + breaker.remaining(candidate.id) > MAX_RETRY_BACKOFF_MS) break;
            await pause(backoffMs(round, retryBackoff, random));
            round += 1;
            wait = 0;
            mode = "best";
            newRound = true;
            continue;
          }
          // Only ejected endpoints are left. Wait for the best one while the call's 2 second budget allows,
          // else stop with the last error rather than send into the cooldown.
          const candidate = board.pick(method, exclude, "best", random);
          const leftMs = candidate ? breaker.remaining(candidate.id) : 0;
          if (leftMs <= 0 || ejectionWaitMs + leftMs > MAX_RETRY_BACKOFF_MS) break;
          ejectionWaitMs += leftMs;
          await pause(leftMs);
        }
        if (!endpoint) {
          if (exhausted) errors.push(exhausted);
          break;
        }
        exclude.add(endpoint.id);
        if (previous && previous.id !== endpoint.id)
          emit({ type: "failover", from: previous.url, to: endpoint.url, method });
        progress();
        try {
          return await dispatch(
            endpoint,
            method,
            params,
            parent,
            idempotent && !background,
            exclude,
            errors,
            attempt === 0 && racing,
          );
        } catch (error: unknown) {
          const wrapped = toError(error);
          errors.push(wrapped);
          if (rebroadcast && attempt > 0 && isAlreadyKnownError(wrapped)) {
            // An earlier attempt delivered these bytes. Report the hash it would have returned.
            const hash = rebroadcastHash(method, params);
            if (hash) return hash;
          }
          const stop = !retries || !shouldFailover(wrapped) || options.shouldThrow?.(wrapped) === true;
          if (stop) throw wrapped;
          previous = endpoint;
        }
      }
      if (errors.length === 1) {
        const only = errors[0];
        if (only) throw only;
      }
      throw new AllEndpointsFailedError(errors);
    };

    /** Labels of the endpoints `picked` was chosen among: eligible, and in its breaker state. */
    const spentPeers = (picked: RankedEndpoint, method: string, exclude: ReadonlySet<string>): string[] => {
      const open = breaker.isOpen(picked.id);
      return built
        .filter(
          (endpoint) =>
            !exclude.has(endpoint.id) &&
            !quarantined(endpoint.id) &&
            endpoint.supports(method) &&
            breaker.isOpen(endpoint.id) === open,
        )
        .map((endpoint) => endpoint.id);
    };

    const dispatch = (
      endpoint: RankedEndpoint,
      method: string,
      params: unknown,
      parent: AbortSignal | undefined,
      idempotent: boolean,
      exclude: Set<string>,
      errors: Error[],
      race: boolean,
    ): Promise<unknown> => {
      const rivals = race ? pickRivals(method, exclude) : [];
      if (rivals.length > 0)
        emit({ type: "race", endpoints: [endpoint.url, ...rivals.map((rival) => rival.url)], method });
      const lead = start(endpoint, method, params, parent, false, true);
      // Rivals join `exclude`, so a race that fails moves on to the endpoints it did not try.
      const primary =
        rivals.length === 0
          ? lead
          : raceCalls(
              [lead, ...rivals.map((rival) => start(rival, method, params, parent, false, true))],
              (error) => !shouldFailover(error) || options.shouldThrow?.(error) === true,
              (lost) => errors.push(...lost),
            );
      if (!hedge.enabled || !idempotent) return primary.promise;
      const wait = board.hedgeDelay(endpoint.id, method, hedge.minDelay, hedge.multiplier);
      return raceHedge(primary, wait, (active) => {
        const next = board.pick(method, exclude, "best", random);
        // A hedge never waits for a token.
        if (!next || breaker.isOpen(next.id) || !budgets.has(next.id)) return undefined;
        exclude.add(next.id);
        const launch = (): Inflight => {
          emit({ type: "hedge", endpoint: next.url, method });
          return start(next, method, params, parent, true, true);
        };
        const target = byId.get(next.id);
        if (!target || gates.get(next.id)?.verified !== false) return launch();
        // An unverified backup is checked now. With probes off, nothing else would ever check it for a hedge.
        return untilAborted(checkChain(target), parent).then(
          // A concurrent call may have ejected the backup while it was checked.
          (reason) => (reason || !active() || breaker.isOpen(next.id) || !budgets.has(next.id) ? undefined : launch()),
          () => undefined,
        );
      });
    };

    /**
     * Endpoints to race beside the lead, synchronously and against the breaker as it is at dispatch.
     * Only verified, unquarantined, closed endpoints with a budget token race. An unverified one is checked in the
     * background instead, unless it is out of budget: a race never waits for a token or spends one on a check.
     */
    const pickRivals = (method: string, exclude: Set<string>): RankedEndpoint[] => {
      const rivals = pickRacers(raceRivals, exclude, {
        next: (skip: ReadonlySet<string>): RankedEndpoint | undefined => board.pick(method, skip, "best", random),
        state: (endpoint: RankedEndpoint): "ready" | "unverified" | "unavailable" => {
          if (breaker.isOpen(endpoint.id) || !budgets.has(endpoint.id)) return "unavailable";
          return gates.get(endpoint.id)?.verified === false ? "unverified" : "ready";
        },
        verify: (endpoint: RankedEndpoint): void => {
          const target = byId.get(endpoint.id);
          if (target) void checkChain(target);
        },
      });
      for (const rival of rivals) exclude.add(rival.id);
      return rivals;
    };

    let closed = false;
    let probing: Promise<void> | undefined;
    let lastProbeAt = Number.NEGATIVE_INFINITY;

    const probe = (): Promise<void> => {
      if (closed) return Promise.resolve();
      lastProbeAt = Date.now();
      // An ejected endpoint is left alone until its cooldown ends. The provider may have asked for the quiet.
      // A child whose `methods` filter rejects `eth_blockNumber` is never probed: viem would refuse it locally.
      // A spent endpoint is skipped, not waited for, and so is one whose chain check took its last token.
      const pending = built.map((endpoint) =>
        breaker.isOpen(endpoint.id) || !endpoint.supports("eth_blockNumber") || !budgets.has(endpoint.id)
          ? Promise.resolve()
          : checkChain(endpoint).then((reason) =>
              reason || !budgets.has(endpoint.id)
                ? undefined
                : start(endpoint, "eth_blockNumber", [], undefined, false, false).promise.then(
                    () => undefined,
                    () => undefined,
                  ),
            ),
      );
      const done = Promise.all(pending).then(() => undefined);
      probing = done;
      void done.finally(() => {
        if (probing === done) probing = undefined;
      });
      return done;
    };

    const probeEvery =
      headLag.enabled && headLag.probeInterval !== false && headLag.probeInterval > 0 ? headLag.probeInterval : 0;
    let probeTimer: ReturnType<typeof setInterval> | undefined;
    let lastRequestAt = 0;
    const activity = new Activity(options.isActive);

    const stopProbes = (): void => {
      if (probeTimer === undefined) return;
      clearInterval(probeTimer);
      probeTimer = undefined;
      activity.unwatch();
    };

    const probeTick = (): void => {
      const idle = headLag.probeIdleTimeout;
      if (idle !== false && Date.now() - lastRequestAt >= idle) {
        stopProbes();
        return;
      }
      // An idle check still runs while inactive, so a hidden tab's timer and listener stop on schedule.
      if (!activity.active()) return;
      void probe();
    };

    /**
     * The page came back into view: probe now instead of waiting out the interval. Switching tabs fires this in
     * bursts, so it probes only when no probe is in flight and none ran in the last interval.
     */
    const probeOnVisible = (): void => {
      if (probing !== undefined || Date.now() - lastProbeAt < probeEvery) return;
      probeTick();
    };

    // Runs on every request. The timer starts here, so building a client does no timer work or I/O.
    const touch = (): void => {
      lastRequestAt = Date.now();
      if (probeEvery === 0 || probeTimer !== undefined) return;
      probeTimer = setInterval(probeTick, probeEvery);
      unrefTimer(probeTimer);
      // A page that comes back into view probes at once instead of waiting out the interval.
      activity.watch(probeOnVisible);
    };

    /**
     * `send()`, shared with identical in-flight reads when coalescing applies. The key is computed on `params` as
     * given, so a params rewrite (pinning `latest`) happens before this. A shared request sits above `send()`,
     * so a race or hedge is never joined halfway.
     */
    const sendShared = (
      method: string,
      params: unknown,
      signal: AbortSignal | undefined,
      idempotent: boolean,
      rebroadcast: boolean,
      barred: ReadonlySet<string>,
      background = false,
    ): Promise<unknown> => {
      const shareKey = coalesce && isCoalescableMethod(method, idempotent) ? coalesceKey(method, params) : undefined;
      if (shareKey === undefined) {
        return send(method, params, signal, idempotent, rebroadcast, barred, noProgress, background);
      }
      return coalescer.request(
        shareKey,
        signal,
        (sharedSignal, progress) =>
          send(method, params, sharedSignal, idempotent, rebroadcast, barred, progress, background),
        () => emit({ type: "coalesce", method }),
      );
    };

    /**
     * The read cache, when `cache` is on. It sits above pinning and coalescing: a hit sends nothing, and a miss is
     * pinned, shared, routed, raced, and failed over like any read, then stored at the block it was pinned to.
     * Its own refreshes pin to the newest head and go through the same shared path, so a call for the same read
     * joins one in flight, but they are never raced or hedged. Heads are what the scoreboard believes: a head
     * ignored as implausible is not served from. Without head tracking there is no head to bound staleness with,
     * so only reads by hash and `eth_chainId` are cached.
     */
    const cache = cacheConfig.enabled
      ? new ReadCache(cacheConfig, {
          now,
          head: (method: string) => {
            let best: { block: number; ageMs: number } | undefined;
            for (const reading of board.heads(Number.POSITIVE_INFINITY)) {
              if (!reading.trusted || !servable(reading.id, method)) continue;
              if (!best || reading.head > best.block) best = { block: reading.head, ageMs: reading.ageMs };
            }
            return best;
          },
          held: (method: string) => {
            // Heads only go up, so any reading is a block its endpoint holds. An endpoint without one may not.
            const heads = new Map(board.heads(Number.POSITIVE_INFINITY).map((reading) => [reading.id, reading]));
            let held: number | undefined;
            for (const endpoint of built) {
              if (!servable(endpoint.id, method)) continue;
              const reading = heads.get(endpoint.id);
              if (reading?.trusted !== true) return undefined;
              if (held === undefined || reading.head < held) held = reading.head;
            }
            return held;
          },
          active: () => activity.active(),
          probe: () => probeBest(),
          read: (method: string, params: unknown) => {
            const pinned = pin.pinTop(method, params);
            return sendShared(method, pinned.params, undefined, true, false, barredFrom(pinned.holders), true).then(
              (result) => ({ result, block: pinned.block }),
            );
          },
          ready: (method: string) => {
            const picked = board.pick(method, NO_BAR, "best", random);
            return picked !== undefined && !breaker.isOpen(picked.id) && budgets.has(picked.id);
          },
          emit,
        })
      : undefined;

    /**
     * One `eth_blockNumber` to the best endpoint that is verified, closed, and funded, so the cache sees each new
     * head without probing the whole pool every second. Like a probe, it scores liveness, not latency.
     */
    const probeBest = async (): Promise<void> => {
      if (closed) return;
      const picked = board.pick("eth_blockNumber", NO_BAR, "best", random);
      if (!picked || breaker.isOpen(picked.id) || !budgets.has(picked.id)) return;
      const target = byId.get(picked.id);
      if (target?.supports("eth_blockNumber") !== true) return;
      const reason = await checkChain(target);
      if (reason || closed || breaker.isOpen(picked.id) || !budgets.has(picked.id)) return;
      await start(picked, "eth_blockNumber", [], undefined, false, false).promise.then(
        () => undefined,
        () => undefined,
      );
    };

    const value: HyperevmTransportValue = {
      onEvent(listener: (event: HyperevmEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: (method = "eth_call"): readonly EndpointSnapshot[] =>
        board
          .snapshot(method)
          .map((entry) => ({ ...entry, quarantined: quarantined(entry.id), tokens: budgets.remaining(entry.id) })),
      scores: (): ScoreSnapshot => warm.scores(),
      restoreScores: (snapshot: unknown): boolean => warm.restore(snapshot),
      endpoints: built.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, weight: endpoint.weight })),
      probe,
      cacheStats: (): CacheStats =>
        cache?.stats() ?? { hits: 0, misses: 0, refreshes: 0, entries: 0, bytes: 0, hotKeys: 0 },
      close(): void {
        if (closed) return;
        closed = true;
        stopProbes();
        cache?.close();
        warm.close();
        if (shared.get(key) === transport) shared.delete(key);
      },
    };

    const transport = createTransport(
      {
        key: options.key ?? "hyperevm",
        name: options.name ?? "HyperEVM",
        retryCount: 0,
        retryDelay,
        timeout,
        type: "hyperevm",
        request: (async (args: EIP1193Parameters, requestOptions?: EIP1193RequestOptions): Promise<unknown> => {
          if (closed) throw new TransportClosedError();
          touch();
          cache?.touch();
          const warming = warm.touch();
          if (warming) await warming;
          const method = args.method;
          const idempotent = isIdempotentMethod(method, extraNonIdempotent);
          const rebroadcast = rebroadcastRaw && isRebroadcastMethod(method);
          const params = "params" in args ? args.params : undefined;
          const signal = requestOptions?.signal;
          if (method === "eth_blockNumber" && idempotent && (pin.answersBlockNumber || cache)) {
            if (signal?.aborted) throw abortError(signal);
            // The pin's block first, so a number returned here is one the next pinned read is served at, then the
            // cache's newest head, lowered the same way. Each caller raises the shared upstream answer on its own,
            // so a joined call never sees a lower block.
            const pinned = pin.blockNumber();
            if (pinned !== undefined) return pinned;
            const local = cache?.blockNumber();
            if (local !== undefined) return pin.answersBlockNumber ? pin.observe(local) : local;
            const upstream = await sendShared(method, params, signal, idempotent, rebroadcast, NO_BAR);
            return pin.answersBlockNumber ? pin.observe(upstream) : upstream;
          }
          const cached = cache?.lookup(method, params, idempotent);
          if (cached?.hit) return cached.result;
          if (cached?.pending) {
            if (signal?.aborted) throw abortError(signal);
            const completed = await cached.pending;
            if (completed !== undefined) return completed;
          }
          // Pin before coalescing: the key is computed on the params as sent, so pinned calls share by block.
          const pinned = pin.pin(method, params, idempotent);
          const result = await sendShared(
            method,
            pinned.params,
            signal,
            idempotent,
            rebroadcast,
            barredFrom(pinned.holders),
          );
          cached?.fill(result, pinned.block);
          return result;
        }) as EIP1193RequestFn,
      },
      value,
    );
    shared.set(key, transport);
    return transport;
  };
}

/**
 * Settle with the first of `primary` and a hedge started after `waitMs`.
 * `startHedge` may return a promise while it checks the backup. It gets a function that is true until the race settles.
 */
function raceHedge(
  primary: Inflight,
  waitMs: number,
  startHedge: (active: () => boolean) => Inflight | undefined | Promise<Inflight | undefined>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let pending = 1;
    let settled = false;
    let hedge: Inflight | undefined;
    let primaryError: Error | undefined;
    const track = (call: Inflight | undefined): void => {
      if (!call) {
        // The backup never started. Only the primary's outcome is left.
        fail(undefined, new Error("The hedge did not start."), false);
        return;
      }
      hedge = call;
      call.promise.then(
        (result) => finish(result, primary),
        (error: unknown) => fail(call, toError(error), false),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      const started = startHedge(() => !settled);
      if (started === undefined) return;
      pending += 1;
      if (started instanceof Promise) started.then(track);
      else track(started);
    }, waitMs);
    // The primary request keeps the process alive. The hedge timer alone should not.
    unrefTimer(timer as ReturnType<typeof setInterval>);

    const finish = (result: unknown, loser: Inflight | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loser?.cancel();
      resolve(result);
    };

    const fail = (call: Inflight | undefined, error: Error, isPrimary: boolean): void => {
      if (call?.cancelled()) return;
      if (settled) return;
      if (isPrimary) primaryError = error;
      pending -= 1;
      if (pending > 0) return;
      settled = true;
      clearTimeout(timer);
      hedge?.cancel();
      reject(primaryError ?? error);
    };

    primary.promise.then(
      (result) => finish(result, hedge),
      (error: unknown) => {
        clearTimeout(timer);
        fail(primary, toError(error), true);
      },
    );
  });
}

/** Jittered exponential backoff: half to all of `base * 2^round`, capped. */
function backoffMs(round: number, base: number, random: () => number): number {
  const ceiling = Math.min(MAX_RETRY_BACKOFF_MS, base * 2 ** round);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** `keccak256` of the signed bytes, which is the hash `eth_sendRawTransaction` returns. */
function rebroadcastHash(method: string, params: unknown): string | undefined {
  if (method !== "eth_sendRawTransaction" || !Array.isArray(params)) return undefined;
  const raw: unknown = params[0];
  if (typeof raw !== "string" || !isHex(raw, { strict: true })) return undefined;
  return keccak256(raw);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toError(signal.reason ?? new Error("This operation was aborted")));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal ? abortError(signal) : new Error("This operation was aborted"));
    };
    // A long-lived caller signal would otherwise keep one listener per retry wait.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Stays ref'd: during a backoff this timer is the only work keeping the call alive.
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Settle with `promise`, or reject with {@link TimeoutError} after `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    unrefTimer(timer as ReturnType<typeof setInterval>);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Settle with `promise`, or reject when `signal` aborts first. The listener is removed either way. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One endpoint after validation, before it has a public label. */
interface PendingEndpoint {
  index: number;
  /** Normalized URL when one is known. Private. */
  url: EndpointUrl | undefined;
  label: string | undefined;
  weight: number;
  instance: ReturnType<Transport>;
  /** Spellings of the URL to scrub from errors. */
  secrets: string[];
  hint: RetryHint;
  budget: BudgetConfig | undefined;
}

/**
 * The latest `Retry-After` on a 429 or 503 from one URL endpoint.
 * viem turns such a response into an RPC error without its headers when the body is a JSON-RPC error.
 */
interface RetryHint {
  /** viem `onFetchResponse`. */
  record: (response: Response) => void;
  /** Milliseconds left of the recorded wait. Clears it. */
  take: () => number;
}

function retryHint(): RetryHint {
  let until = 0;
  return {
    record(response: Response): void {
      if (response.status !== 429 && response.status !== 503) return;
      const asked = retryAfterMs({ headers: response.headers }, Date.now());
      if (asked > 0) until = Math.max(until, Date.now() + asked);
    },
    take(): number {
      const left = Math.max(0, until - Date.now());
      until = 0;
      return left;
    },
  };
}

function buildEndpoints(options: HyperevmTransportOptions, chain: Chain | undefined, timeout: number): BuiltEndpoint[] {
  const explicit = options.endpoints !== undefined;
  const inputs: readonly HyperevmEndpoint[] =
    options.endpoints ?? registryHttpEndpoints().map((endpoint) => endpoint.url);
  const pending: PendingEndpoint[] = [];
  const fallbackBudget = resolveDefaultBudget(options.budget);
  const urls = new Set<string>();
  const labels = new Set<string>();
  inputs.forEach((input, index) => {
    const config = endpointConfig(input, index);
    const given = config.url === undefined ? undefined : endpointUrlAt(config.url, index);
    const hint = retryHint();
    const transport = given ? toChildTransport(given, options, timeout, hint) : config.transport;
    if (!transport) throw new Error(`hyperevm() endpoints[${index}] needs a url or a transport.`);
    const instance = transport({ chain, retryCount: 0, timeout });
    const childUrl = given ? undefined : endpointUrl(instance.value);
    const url = given ?? (childUrl === undefined ? undefined : tryEndpointUrl(childUrl));
    const weight = config.weight ?? (given ? weightFor(given.url, explicit) : 1);
    if (!explicit && weight <= 0) return;
    if (url) {
      if (urls.has(url.url)) {
        throw new Error(`hyperevm() endpoints list ${config.label ?? publicUrl(url)} more than once.`);
      }
      urls.add(url.url);
    }
    if (config.label !== undefined) {
      if (labels.has(config.label)) {
        throw new Error(`hyperevm() endpoint label "${config.label}" is used more than once.`);
      }
      labels.add(config.label);
    }
    const secrets = url && !isRegistryUrl(url.url) ? [config.url, url.url, childUrl] : [];
    pending.push({
      index,
      url,
      label: config.label,
      weight,
      instance,
      secrets: secrets.filter((secret): secret is string => secret !== undefined),
      hint,
      budget:
        resolveEndpointBudget(config, fallbackBudget, `hyperevm() endpoints[${index}]`) ??
        (fallbackBudget === false || !url ? undefined : KNOWN_BUDGETS.get(url.url)),
    });
  });
  return pending.map((entry) => {
    const label = entry.label ?? uniqueLabel(entry.url ? publicUrl(entry.url) : `transport:${entry.index}`, labels);
    const { instance } = entry;
    const methods = instance.config.methods as { include?: readonly string[]; exclude?: readonly string[] } | undefined;
    return {
      id: label,
      url: label,
      weight: entry.weight,
      supports: (method: string): boolean => supportsMethod(methods, method),
      request: redactErrors(instance.request as BuiltEndpoint["request"], entry.secrets, label),
      retryAfter: entry.hint.take,
      budget: entry.budget,
    };
  });
}

/** Validate one `endpoints` entry and lift it to the object form. */
function endpointConfig(input: HyperevmEndpoint, index: number): HyperevmEndpointConfig {
  if (typeof input === "string") return { url: input };
  if (typeof input === "function") return { transport: input };
  const where = `hyperevm() endpoints[${index}]`;
  if ((input.url === undefined) === (input.transport === undefined)) {
    throw new Error(`${where} needs exactly one of url or transport.`);
  }
  if (input.label !== undefined && input.label.trim() === "") throw new Error(`${where}.label must not be empty.`);
  if (input.weight !== undefined && !(Number.isFinite(input.weight) && input.weight > 0)) {
    throw new Error(`${where}.weight must be a finite number above 0.`);
  }
  return input;
}

function endpointUrlAt(url: string, index: number): EndpointUrl {
  try {
    return normalizeEndpointUrl(url);
  } catch (error) {
    throw new Error(`hyperevm() endpoints[${index}]: ${toError(error).message}`);
  }
}

function tryEndpointUrl(url: string): EndpointUrl | undefined {
  try {
    return normalizeEndpointUrl(url);
  } catch {
    return undefined;
  }
}

function isRegistryUrl(url: string): boolean {
  return defaultRegistry.endpoints.some((endpoint) => endpoint.url === url);
}

/** Registry URLs are public and keyless, so they stay whole. Anything else shows only its origin. */
function publicUrl(url: EndpointUrl): string {
  return isRegistryUrl(url.url) ? url.url : url.origin;
}

/** `base`, or `base#2`, `base#3`, ... when taken. Records the result in `used`. */
function uniqueLabel(base: string, used: Set<string>): string {
  let label = base;
  for (let suffix = 2; used.has(label); suffix += 1) label = `${base}#${suffix}`;
  used.add(label);
  return label;
}

/** Replace every spelling of a private URL with `label` in errors thrown by `request`, including causes. */
function redactErrors(
  request: BuiltEndpoint["request"],
  secrets: readonly string[],
  label: string,
): BuiltEndpoint["request"] {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    for (const spelling of [secret, secret.trim(), withoutCredentials(secret)]) {
      if (spelling !== "" && spelling !== label) spellings.add(spelling);
    }
  }
  if (spellings.size === 0) return request;
  const ordered = [...spellings].sort((left, right) => right.length - left.length);
  const scrub = (text: string): string => ordered.reduce((out, spelling) => out.replaceAll(spelling, label), text);
  return async (args: { method: string; params?: unknown }, options?: { signal?: AbortSignal }): Promise<unknown> => {
    try {
      return await request(args, options);
    } catch (error: unknown) {
      throw scrubError(error, scrub);
    }
  };
}

/**
 * Scrub every string `error` holds at any depth, property names included: its own properties and cause, an inherited
 * `message` or `stack` (a DOMException's), the plain objects and arrays under them, and `Headers`. viem keeps the
 * provider's JSON-RPC error, `data` included, as a plain-object cause, and an HTTP error keeps the response headers.
 *
 * Fields are rewritten in place, so error classes and identity survive. A node that cannot be rewritten (frozen,
 * read-only, or a getter) is replaced with a scrubbed copy on the same prototype, linked into its parents. A parent
 * that cannot take it is replaced too, up to the top. Returns `error`, or its replacement. The walk keeps its own
 * stack, so deep `data` cannot overflow.
 */
function scrubError(error: unknown, scrub: (text: string) => string): unknown {
  const root = scrubLeaf(error, scrub);
  if (root !== error) return root;
  const seen = new WeakSet<object>();
  const parents = new Map<object, { parent: object; key: string }[]>();
  const stuck: object[] = [];
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!isWalkable(value) || seen.has(value)) continue;
    seen.add(value);
    let rewritten = true;
    for (const key of keysOf(value)) {
      const item: unknown = Reflect.get(value, key);
      const scrubbed = scrubLeaf(item, scrub);
      if (scrubbed !== item) {
        if (!write(value, key, scrubbed)) rewritten = false;
      } else if (isWalkable(item)) {
        parents.set(item, [...(parents.get(item) ?? []), { parent: value, key }]);
        pending.push(item);
      }
    }
    if (!Array.isArray(value) && !scrubKeys(value, scrub)) rewritten = false;
    if (!rewritten) stuck.push(value);
  }
  const copies = new Map<object, object>();
  const replace = (node: object): void => {
    if (copies.has(node)) return;
    const copy = scrubbedCopy(node, scrub, copies);
    copies.set(node, copy);
    // The parent's names were scrubbed in place or in its own copy, so the link lives under the scrubbed name.
    for (const { parent, key } of parents.get(node) ?? []) {
      if (!write(copies.get(parent) ?? parent, scrub(key), copy)) replace(parent);
    }
  };
  for (const node of stuck) replace(node);
  return isWalkable(error) ? (copies.get(error) ?? error) : error;
}

/** Errors, arrays, and plain objects. Other class instances are left alone. */
function isWalkable(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  return value instanceof Error || Array.isArray(value) || isPlainObject(value);
}

/** Properties to scrub. An error's `name`, `message`, `stack`, and `code` may be inherited, as on a DOMException. */
function keysOf(value: object): Iterable<string> {
  if (!(value instanceof Error)) return Object.keys(value);
  const keys = new Set([...Object.getOwnPropertyNames(value), "name", "message", "stack", "cause"]);
  if ("code" in value) keys.add("code");
  return keys;
}

/** A scrubbed string, a scrubbed copy of `Headers`, or `item` itself. */
function scrubLeaf(item: unknown, scrub: (text: string) => string): unknown {
  if (typeof item === "string") return scrub(item);
  if (item instanceof Headers) return scrubHeaders(item, scrub);
  return item;
}

/** Set `key` and read it back. False when the object is frozen, the field is read-only, or a setter ignored it. */
function write(target: object, key: string, value: unknown): boolean {
  return Reflect.set(target, key, value) && Reflect.get(target, key) === value;
}

/** A writable copy of `node` on the same prototype, with scrubbed fields and names and any replaced children. */
function scrubbedCopy(node: object, scrub: (text: string) => string, copies: ReadonlyMap<object, object>): object {
  const clean = (item: unknown): unknown => {
    const scrubbed = scrubLeaf(item, scrub);
    return typeof scrubbed === "object" && scrubbed !== null ? (copies.get(scrubbed) ?? scrubbed) : scrubbed;
  };
  if (Array.isArray(node)) return Array.from(node, clean);
  const copy: object = Object.create(Object.getPrototypeOf(node));
  for (const key of keysOf(node)) {
    const own = Object.getOwnPropertyDescriptor(node, key);
    const item: unknown = Reflect.get(node, key);
    if (item === undefined && !own) continue;
    Object.defineProperty(copy, scrub(key), {
      value: clean(item),
      writable: true,
      configurable: true,
      enumerable: own?.enumerable ?? false,
    });
  }
  return copy;
}

/**
 * Rename properties whose names hold a secret, in place. A gateway may key error data by URL.
 * A plain object has every property re-added, so its key order survives. False when the object cannot be changed.
 */
function scrubKeys(value: object, scrub: (text: string) => string): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (names.every((name) => scrub(name) === name)) return true;
  if (!Object.isExtensible(value)) return false;
  const keepOrder = !(value instanceof Error);
  let renamed = true;
  for (const name of names) {
    const scrubbed = scrub(name);
    if (scrubbed === name && !keepOrder) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Reflect.deleteProperty(value, name)) {
      if (scrubbed !== name) renamed = false;
      continue;
    }
    Reflect.defineProperty(value, scrubbed, descriptor);
  }
  return renamed;
}

/** `headers`, or a scrubbed copy when a value held a secret. A response's headers are immutable, so they are replaced. */
function scrubHeaders(headers: Headers, scrub: (text: string) => string): Headers {
  const copy = new Headers();
  let changed = false;
  for (const [name, item] of headers) {
    const scrubbed = scrub(item);
    if (scrubbed !== item) changed = true;
    copy.append(name, scrubbed);
  }
  return changed ? copy : headers;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The URL as viem prints it in errors, with basic-auth credentials removed. */
function withoutCredentials(url: string): string {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function toChildTransport(
  url: EndpointUrl,
  options: HyperevmTransportOptions,
  timeout: number,
  hint: RetryHint,
): Transport {
  if (url.kind === "websocket") return webSocket(url.url);
  return http(url.url, {
    batch: options.batch,
    fetchFn: options.fetchFn,
    onFetchResponse: hint.record,
    retryCount: 0,
    timeout,
  });
}

/** The URL a viem transport reports on its value, if any. */
function endpointUrl(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  return undefined;
}
