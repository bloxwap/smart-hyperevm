/**
 * Block-bounded read cache: idempotent reads answered from memory, at most a block behind the newest head.
 *
 * A round trip to any HyperEVM RPC takes tens of milliseconds, so a read answered in under a millisecond has to
 * come from memory. HyperEVM makes a small block about every second and has instant finality (HyperBFT: a block is
 * final when it is made, and there are no reorgs), so an answer is correct for the block it was read at, and data
 * named by a block number or hash never changes. The cache stamps each answer with that block and serves it while
 * it is within `maxStaleBlocks` of the newest head the transport knows, and younger than `maxAgeMs`.
 *
 * Keys read recently are kept hot: on each new head they are read again in the background, pinned to that head,
 * so the next call hits memory. While keys are hot, a tick sends one `eth_blockNumber` a second to the best
 * endpoint, since the default probe cadence would see every fourth block. The tick and the refreshes stop when the
 * keys go idle and while the page is hidden. Log filters seen recently keep a rolling index of the last
 * `logsWindow` blocks, extended by the new blocks only, so a range query inside the window never scans upstream.
 *
 * Nothing is cached for sends, nonces at `"latest"` or `"pending"`, gas estimates and prices, filters,
 * subscriptions, or errors. HyperCore read precompiles ignore the block tag, so their answers are bounded by time.
 * @module
 */

import { coalesceKey } from "./_coalesce.ts";
import type { HyperevmEvent } from "./_events.ts";
import { isPrecompileCall } from "./_pin.ts";
import { parseQuantity } from "./_scoreboard.ts";

/** Blocks a cached `"latest"` answer may trail the newest head. */
export const DEFAULT_CACHE_MAX_STALE_BLOCKS = 1;

/** Milliseconds a cached `"latest"` or precompile answer may be served, whatever the head. */
export const DEFAULT_CACHE_MAX_AGE_MS = 2_000;

/** Milliseconds between head ticks while keys are hot. HyperEVM makes a small block about every second. */
export const DEFAULT_CACHE_REFRESH_INTERVAL_MS = 1_000;

/** Keys refreshed in the background. */
export const DEFAULT_CACHE_HOT_KEYS = 64;

/** A key not read for this long is no longer refreshed. */
export const DEFAULT_CACHE_HOT_IDLE_MS = 30_000;

/** Entries kept across every store. */
export const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

/** Approximate bytes kept across every store. */
export const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** Blocks a log index covers. The providers cap a range at 1000. */
export const DEFAULT_CACHE_LOGS_WINDOW = 1_000;

/** Options for `cache`. */
export interface CacheOptions {
  /** Blocks a cached `"latest"` answer may trail the newest known head. 0 serves only answers at it. Default: 1. */
  maxStaleBlocks?: number | undefined;
  /** Milliseconds a cached `"latest"` or precompile answer may be served, whatever the head. Default: 2000. */
  maxAgeMs?: number | undefined;
  /**
   * Milliseconds between head ticks while keys are hot. Each tick sends one `eth_blockNumber`, and a new head
   * refreshes every hot key. `false` sends no ticks: hot keys are still refreshed when a probe or a call brings a
   * new head. Default: 1000.
   */
  refreshInterval?: number | false | undefined;
  /** Keys kept hot, least recently read first out. Default: 64. */
  hotKeys?: number | undefined;
  /** A key not read for this many milliseconds stops being refreshed. Default: 30000. */
  hotIdleMs?: number | undefined;
  /** Entries kept, least recently used first out. Default: 1000. */
  maxEntries?: number | undefined;
  /** Approximate bytes kept. Default: 8 MiB. */
  maxBytes?: number | undefined;
  /** Blocks each log index keeps, from the newest head back. Default: 1000. */
  logsWindow?: number | undefined;
  /**
   * Deep-copy answers when they are stored and returned, so callers cannot mutate the cache. `false` shares result
   * objects and is faster only when every caller treats them as immutable. Default: true.
   */
  copyResults?: boolean | undefined;
  /**
   * Reuse a cache plan when the same params array is passed again. The array and every nested value must never be
   * mutated, since identity is what detects reuse. Default: false.
   */
  immutableParams?: boolean | undefined;
}

/** Resolved `cache` settings. */
export interface CacheConfig {
  enabled: boolean;
  maxStaleBlocks: number;
  maxAgeMs: number;
  refreshInterval: number | false;
  hotKeys: number;
  hotIdleMs: number;
  maxEntries: number;
  maxBytes: number;
  logsWindow: number;
  copyResults: boolean;
  immutableParams: boolean;
}

/** Counters and sizes, as `value.cacheStats()` reports them. */
export interface CacheStats {
  /** Calls answered from memory. */
  hits: number;
  /** Cacheable calls sent upstream. */
  misses: number;
  /** Background reads started. */
  refreshes: number;
  entries: number;
  bytes: number;
  hotKeys: number;
}

export function resolveCache(value: boolean | CacheOptions | undefined): CacheConfig {
  const options = typeof value === "object" ? value : {};
  const config: CacheConfig = {
    enabled: value !== false,
    maxStaleBlocks: options.maxStaleBlocks ?? DEFAULT_CACHE_MAX_STALE_BLOCKS,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
    refreshInterval:
      options.refreshInterval === undefined ? DEFAULT_CACHE_REFRESH_INTERVAL_MS : options.refreshInterval,
    hotKeys: options.hotKeys ?? DEFAULT_CACHE_HOT_KEYS,
    hotIdleMs: options.hotIdleMs ?? DEFAULT_CACHE_HOT_IDLE_MS,
    maxEntries: options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES,
    logsWindow: options.logsWindow ?? DEFAULT_CACHE_LOGS_WINDOW,
    copyResults: options.copyResults ?? true,
    immutableParams: options.immutableParams ?? false,
  };
  for (const name of ["maxStaleBlocks", "maxAgeMs", "hotKeys", "hotIdleMs", "maxEntries", "maxBytes"] as const) {
    if (!Number.isFinite(config[name]) || config[name] < 0) {
      throw new Error(`smartHyperevm() cache.${name} must be a finite number, 0 or more, got ${config[name]}.`);
    }
  }
  if (!Number.isInteger(config.logsWindow) || config.logsWindow < 1) {
    throw new Error(`smartHyperevm() cache.logsWindow must be an integer of at least 1, got ${config.logsWindow}.`);
  }
  if (config.refreshInterval !== false && !(Number.isFinite(config.refreshInterval) && config.refreshInterval > 0)) {
    throw new Error(
      `smartHyperevm() cache.refreshInterval must be a positive number or false, got ${config.refreshInterval}.`,
    );
  }
  return config;
}

/** A background read's answer and the block it was pinned to. */
export interface CacheRead {
  result: unknown;
  /** Undefined when the read was not pinned. The cache then stamps it with the block every endpoint holds. */
  block: number | undefined;
}

/** What the cache reads from, and sends through, the transport. */
export interface CacheSource {
  /** Clock for entry ages. */
  now: () => number;
  /** Newest trusted head among the endpoints that may serve `method`, and how old its reading is. */
  head: (method: string) => { block: number; ageMs: number } | undefined;
  /** The block every endpoint that may serve `method` is known to hold. Undefined while one has no head. */
  held: (method: string) => number | undefined;
  /** False while the page or app is hidden. Ticks and refreshes then send nothing. */
  active: () => boolean;
  /** Send one `eth_blockNumber` to the best endpoint with budget. Resolves once its head is noted. */
  probe: () => Promise<void>;
  /** A read pinned to the newest head and shared like a call, but never raced or hedged. */
  read: (method: string, params: unknown) => Promise<CacheRead>;
  /** True when some endpoint can take a read of `method` now without waiting for a budget token. */
  ready: (method: string) => boolean;
  emit: (event: HyperevmEvent) => void;
}

/** An answer from memory. */
export interface CacheHit {
  hit: true;
  result: unknown;
}

/** A cacheable call that goes upstream. `fill` stores the answer; `pending` first tries to complete a log index. */
export interface CacheMiss {
  hit: false;
  /** Store the upstream answer, read at `block` when the call was pinned. Errors are never stored. */
  fill: (result: unknown, block: number | undefined) => void;
  /**
   * For a log query whose index covers the start of the range but not its end: the missing blocks are fetched
   * and the answer comes from the index. Undefined when that fetch failed, and the call goes upstream as usual.
   */
  pending?: Promise<unknown | undefined> | undefined;
}

/** Where a method carries its block tag, whether an omitted tag means `"latest"`, and what may be cached. */
interface BlockSlot {
  index: number;
  implied: boolean;
  /** Cache at `"latest"`. A nonce at `"latest"` or `"pending"` is never cached: a stale one breaks the next send. */
  latest: boolean;
  /** A state read: at an explicit block it is cached only when every endpoint that could have answered holds it. */
  state: boolean;
}

const BLOCK_SLOTS: ReadonlyMap<string, BlockSlot> = new Map([
  ["eth_call", { index: 1, implied: true, latest: true, state: true }],
  ["eth_getBalance", { index: 1, implied: true, latest: true, state: true }],
  ["eth_getCode", { index: 1, implied: true, latest: true, state: true }],
  ["eth_getStorageAt", { index: 2, implied: true, latest: true, state: true }],
  ["eth_getTransactionCount", { index: 1, implied: true, latest: false, state: true }],
  ["eth_getBlockByNumber", { index: 0, implied: false, latest: true, state: false }],
  ["eth_getBlockTransactionCountByNumber", { index: 0, implied: false, latest: false, state: false }],
  ["eth_getTransactionByBlockNumberAndIndex", { index: 0, implied: false, latest: false, state: false }],
]);

/** Reads named by a hash. Final at once on HyperEVM, so a non-null answer is kept for good. */
const BY_HASH: ReadonlySet<string> = new Set([
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockHashAndIndex",
]);

type Kind = "latest" | "timed" | "immutable" | "number" | "logs";

/** A log filter's range bounds, as given. Other tags are not cached. */
type Bound = number | "latest";

/** One call's place in the cache, decided from its method and params alone. */
interface Plan {
  kind: Kind;
  method: string;
  /** Store key. Latest, timed, and number plans share the key of the read with its block tag dropped. */
  key: string;
  /** The params as given, with hex lower-cased. Hot keys are re-read with these. */
  params: unknown;
  /** `number`: the explicit block, and the immutable store key for the read at it. */
  block?: number | undefined;
  exact?: string | undefined;
  /** Explicit blocks are kept only when every endpoint that could have answered holds them. */
  guard: boolean;
  /** `logs`: the filter without its range, and the range. */
  filter?: Record<string, unknown> | undefined;
  from?: Bound | undefined;
  to?: Bound | undefined;
}

interface ValueEntry {
  kind: "latest" | "timed" | "immutable";
  result: unknown;
  /** The block the answer was read at. Immutable and timed entries keep the head at the time, for the record. */
  block: number;
  at: number;
  bytes: number;
}

interface LogsEntry {
  kind: "logs";
  /** Blocks covered, inclusive. Every log of the filter in them is in `logs`, in block then log index order. */
  from: number;
  to: number;
  logs: Log[];
  at: number;
  bytes: number;
}

type Entry = ValueEntry | LogsEntry;

interface Log {
  blockNumber: number;
  logIndex: number;
  value: Record<string, unknown>;
  bytes: number;
}

interface HotKey {
  plan: Plan;
  lastReadAt: number;
  /** A background read in flight. Another is not started until it settles. */
  refreshing: boolean;
}

const HEX = /^0x[0-9a-f]*$/i;

function toHex(block: number): string {
  return `0x${block.toString(16)}`;
}

/** One instance's read cache. */
export class ReadCache {
  readonly #config: CacheConfig;
  readonly #source: CacheSource;
  /** Every store in one map. Insertion order is recency. */
  readonly #entries = new Map<string, Entry>();
  readonly #hot = new Map<string, HotKey>();
  readonly #plans = new WeakMap<object, Map<string, Plan | null>>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #refreshes = 0;
  /** The highest `eth_blockNumber` answered locally, so answers never go back. */
  #servedHead = -1;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the armed timer should have fired. */
  #dueAt = 0;
  /** A refresh round queued behind a new head. */
  #roundQueued = false;
  #closed = false;

  constructor(config: CacheConfig, source: CacheSource) {
    this.#config = config;
    this.#source = source;
  }

  #plan(method: string, params: unknown): Plan | undefined {
    return planFor(method, params, this.#config.immutableParams ? this.#plans : undefined);
  }

  #copy(value: unknown): unknown {
    return this.#config.copyResults ? copy(value) : value;
  }

  stats(): CacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      refreshes: this.#refreshes,
      entries: this.#entries.size,
      bytes: this.#bytes,
      hotKeys: this.#hot.size,
    };
  }

  /**
   * The local `eth_blockNumber` answer: the newest trusted head, while its reading is younger than `maxAgeMs`.
   * Never lower than one already returned. Undefined when the call must go upstream.
   */
  blockNumber(): string | undefined {
    const head = this.#source.head("eth_blockNumber");
    if (!head || head.ageMs > this.#config.maxAgeMs) return undefined;
    if (head.block > this.#servedHead) this.#servedHead = head.block;
    return toHex(this.#servedHead);
  }

  /**
   * Answer `method` from memory, or say how to store its upstream answer. Undefined for a call that is never
   * cached. Hits are copies unless `copyResults` is false. A cacheable `"latest"`, precompile, or log read
   * becomes a hot key.
   */
  lookup(method: string, params: unknown, idempotent: boolean): CacheHit | CacheMiss | undefined {
    if (!idempotent || this.#closed) return undefined;
    const plan = this.#plan(method, params);
    if (!plan) return undefined;
    const now = this.#source.now();
    const hit = this.#serve(plan, now);
    if (plan.kind === "latest" || plan.kind === "timed" || plan.kind === "logs") this.#watch(plan, now);
    if (hit) {
      this.#hits += 1;
      this.#source.emit({ type: "cache", method, outcome: "hit", staleBlocks: hit.staleBlocks });
      return { hit: true, result: hit.result };
    }
    this.#misses += 1;
    this.#source.emit({ type: "cache", method, outcome: "miss", staleBlocks: null });
    const miss: CacheMiss = {
      hit: false,
      fill: (result: unknown, block: number | undefined): void => this.#fill(plan, result, block),
    };
    if (plan.kind === "logs") {
      const tail = this.#tail(plan);
      if (tail) miss.pending = this.#complete(plan, tail);
    }
    return miss;
  }

  /** Runs on every request. Re-arms a tick timer the runtime dropped with the invocation that set it. */
  touch(): void {
    if (this.#hot.size === 0 || this.#closed) return;
    if (this.#timer !== undefined && Date.now() < this.#dueAt) return;
    this.#arm();
  }

  /** A head moved. Hot keys behind it are refreshed once the current task yields. */
  headChanged(): void {
    if (this.#roundQueued || this.#closed || this.#hot.size === 0) return;
    this.#roundQueued = true;
    queueMicrotask(() => {
      this.#roundQueued = false;
      this.#round(false);
    });
  }

  /** Stop the tick. Entries stay for calls already in flight. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The answer for `plan` from memory, with its staleness against the newest head, or undefined. */
  #serve(plan: Plan, now: number): { result: unknown; staleBlocks: number | null } | undefined {
    switch (plan.kind) {
      case "latest": {
        const head = this.#source.head(plan.method)?.block;
        const entry = this.#value(plan.key, "latest");
        if (!entry || head === undefined) return undefined;
        if (head - entry.block > this.#config.maxStaleBlocks || now - entry.at > this.#config.maxAgeMs)
          return undefined;
        return { result: this.#copy(entry.result), staleBlocks: Math.max(0, head - entry.block) };
      }
      case "timed": {
        const entry = this.#value(plan.key, "timed");
        if (!entry || now - entry.at > this.#config.maxAgeMs) return undefined;
        return { result: this.#copy(entry.result), staleBlocks: null };
      }
      case "immutable": {
        const entry = this.#value(plan.key, "immutable");
        return entry ? { result: this.#copy(entry.result), staleBlocks: 0 } : undefined;
      }
      case "number": {
        if (plan.block === undefined || plan.exact === undefined) return undefined;
        // The latest answer, when it was read at exactly this block: a caller that pins for itself hits it.
        const latest = this.#value(plan.key, "latest");
        if (latest && latest.block === plan.block) return { result: this.#copy(latest.result), staleBlocks: 0 };
        const entry = this.#value(plan.exact, "immutable");
        return entry ? { result: this.#copy(entry.result), staleBlocks: 0 } : undefined;
      }
      case "logs": {
        const head = this.#source.head(plan.method)?.block;
        const range = this.#range(plan, head);
        const entry = this.#logs(plan.key);
        if (!range || !entry || range.from < entry.from || range.from > entry.to) return undefined;
        const slack = plan.to === "latest" ? this.#config.maxStaleBlocks : 0;
        if (range.to - entry.to > slack) return undefined;
        if (plan.to === "latest" && now - entry.at > this.#config.maxAgeMs) return undefined;
        return {
          result: selectLogs(entry.logs, range.from, range.to, this.#config.copyResults),
          staleBlocks: plan.to === "latest" && head !== undefined ? Math.max(0, head - entry.to) : 0,
        };
      }
    }
  }

  /** Store an upstream answer for `plan`. `block` is the pinned block, when the call was pinned. */
  #fill(plan: Plan, result: unknown, block: number | undefined): void {
    if (this.#closed || result === null || result === undefined) return;
    const now = this.#source.now();
    switch (plan.kind) {
      case "latest": {
        // A block fetched at "latest" says which block it is. Anything else is at the pinned block, or, unpinned,
        // at the block every endpoint that could have answered holds.
        const at = plan.method === "eth_getBlockByNumber" ? blockOf(result) : null;
        const stamped = at ?? block ?? this.#source.held(plan.method);
        if (stamped === undefined) return;
        this.#set(plan.key, {
          kind: "latest",
          result: this.#copy(result),
          block: stamped,
          at: now,
          bytes: sizeOf(result),
        });
        return;
      }
      case "timed": {
        const head = this.#source.head(plan.method)?.block ?? -1;
        this.#set(plan.key, {
          kind: "timed",
          result: this.#copy(result),
          block: head,
          at: now,
          bytes: sizeOf(result),
        });
        return;
      }
      case "immutable": {
        if (plan.method === "eth_getTransactionByHash" && blockOf(result) === null) return;
        const head = this.#source.head(plan.method)?.block ?? -1;
        this.#set(plan.key, {
          kind: "immutable",
          result: this.#copy(result),
          block: head,
          at: now,
          bytes: sizeOf(result),
        });
        return;
      }
      case "number": {
        if (plan.block === undefined || plan.exact === undefined) return;
        if (plan.guard && !this.#holdsAll(plan.method, plan.block)) return;
        this.#set(plan.exact, {
          kind: "immutable",
          result: this.#copy(result),
          block: plan.block,
          at: now,
          bytes: sizeOf(result),
        });
        return;
      }
      case "logs": {
        if (!Array.isArray(result) || plan.from === undefined || plan.to === undefined) return;
        // The range as answered: a pinned "latest" is exact, an unpinned one is what every endpoint holds, and
        // an explicit end is kept only when every endpoint that could have answered holds it.
        const to = plan.to === "latest" ? (block ?? this.#source.held(plan.method)) : plan.to;
        if (to === undefined || (plan.to !== "latest" && !this.#holdsAll(plan.method, to))) return;
        const from = plan.from === "latest" ? to : plan.from;
        if (from > to) return;
        const logs = parseLogs(result, this.#config.copyResults);
        if (!logs) return;
        this.#merge(plan.key, from, to, logs, now);
      }
    }
  }

  /** The upstream params that extend `plan`'s index to the newest head, or undefined when it is not behind. */
  #tail(plan: Plan): unknown {
    if (plan.filter === undefined || plan.from === undefined || plan.to !== "latest") return undefined;
    const head = this.#source.head(plan.method)?.block;
    const entry = this.#logs(plan.key);
    if (head === undefined || !entry || entry.to >= head) return undefined;
    const from = plan.from === "latest" ? head : plan.from;
    // The index must reach the start of the query, or the whole range goes upstream and seeds it.
    if (from < entry.from || from > entry.to + 1) return undefined;
    return [{ ...plan.filter, fromBlock: toHex(entry.to + 1), toBlock: "latest" }];
  }

  /** Fetch `tail`, merge it, and answer `plan` from the index. Undefined when the fetch failed or did not reach. */
  async #complete(plan: Plan, tail: unknown): Promise<unknown | undefined> {
    const read = await this.#read("eth_getLogs", tail, "miss");
    if (!read) return undefined;
    return this.#serve(plan, this.#source.now())?.result;
  }

  /** Keep `plan` hot. The list is ordered by last read, and the oldest leaves when it is full. */
  #watch(plan: Plan, now: number): void {
    const existing = this.#hot.get(plan.key);
    if (existing) {
      this.#hot.delete(plan.key);
      existing.lastReadAt = now;
      existing.plan = plan;
      this.#hot.set(plan.key, existing);
    } else {
      this.#hot.set(plan.key, { plan, lastReadAt: now, refreshing: false });
      while (this.#hot.size > this.#config.hotKeys) {
        const oldest = this.#hot.keys().next().value;
        if (oldest === undefined) break;
        this.#hot.delete(oldest);
      }
    }
    this.touch();
  }

  #arm(): void {
    if (this.#config.refreshInterval === false || this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#dueAt = Date.now() + this.#config.refreshInterval;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#tick();
    }, this.#config.refreshInterval);
    // Keeping keys warm is not a call's work. It should not keep a short-lived process alive.
    unrefTimer(this.#timer);
  }

  /**
   * One tick: drop idle keys, stop when none is left, else refresh what is behind or expiring and probe the head.
   * The round goes first, so a slow probe never holds a precompile refresh past `maxAgeMs`. A head the probe
   * brings runs its own round.
   */
  async #tick(): Promise<void> {
    const now = this.#source.now();
    for (const [key, hot] of this.#hot) if (now - hot.lastReadAt > this.#config.hotIdleMs) this.#hot.delete(key);
    if (this.#hot.size === 0 || this.#closed) return;
    this.#arm();
    if (!this.#source.active()) return;
    this.#round(true);
    if (this.#source.ready("eth_blockNumber")) await this.#source.probe();
  }

  /** Refresh every hot key that is behind the newest head. On a tick, precompile reads are refreshed too. */
  #round(tick: boolean): void {
    if (this.#closed || !this.#source.active()) return;
    for (const hot of [...this.#hot.values()]) {
      if (hot.refreshing) continue;
      const params = this.#stale(hot.plan, tick);
      if (params === undefined || !this.#source.ready(hot.plan.method)) continue;
      hot.refreshing = true;
      void this.#read(hot.plan.method, params, "refresh").finally(() => {
        hot.refreshing = false;
      });
    }
  }

  /** The params to re-read `plan` with when its entry is behind the newest head or about to expire, else undefined. */
  #stale(plan: Plan, tick: boolean): unknown {
    const now = this.#source.now();
    const interval = this.#config.refreshInterval === false ? 0 : this.#config.refreshInterval;
    switch (plan.kind) {
      case "latest": {
        const head = this.#source.head(plan.method)?.block;
        const entry = this.#value(plan.key, "latest");
        if (head === undefined) return undefined;
        // Refresh when behind, or when the entry would expire before the next tick could refresh it.
        if (entry && entry.block >= head && now - entry.at + interval <= this.#config.maxAgeMs) return undefined;
        return plan.params;
      }
      case "timed":
        return tick ? plan.params : undefined;
      case "logs": {
        const head = this.#source.head(plan.method)?.block;
        const entry = this.#logs(plan.key);
        if (!entry) return plan.params;
        if (head === undefined || entry.to >= head) return undefined;
        return this.#tail(plan);
      }
    }
  }

  /** A background read of `params`, stored on success. Resolves to true when it was stored. */
  async #read(method: string, params: unknown, why: "refresh" | "miss"): Promise<boolean> {
    const plan = this.#plan(method, params);
    if (!plan) return false;
    if (why === "refresh") {
      this.#refreshes += 1;
      this.#source.emit({ type: "cache", method, outcome: "refresh", staleBlocks: null });
    }
    try {
      const read = await this.#source.read(method, params);
      this.#fill(plan, read.result, read.block);
      return true;
    } catch (error) {
      // The entry it would have replaced stays, and the next head or tick tries again.
      void error;
      return false;
    }
  }

  /** `[from, to]` for a log query, with `"latest"` resolved to the newest head. */
  #range(plan: Plan, head: number | undefined): { from: number; to: number } | undefined {
    if (plan.from === undefined || plan.to === undefined) return undefined;
    const from = plan.from === "latest" ? head : plan.from;
    const to = plan.to === "latest" ? head : plan.to;
    if (from === undefined || to === undefined || from > to) return undefined;
    return { from, to };
  }

  /** Add logs for `[from, to]` to `key`'s index, replacing it when the ranges do not touch, and trim to the window. */
  #merge(key: string, from: number, to: number, logs: Log[], now: number): void {
    const existing = this.#logs(key);
    const ordered = inOrder(logs) ? logs : [...logs].sort(byPosition);
    let merged: Log[];
    let bytes = totalBytes(ordered);
    let low = from;
    let high = to;
    if (existing && from === existing.to + 1) {
      merged = existing.logs.concat(ordered);
      bytes += existing.bytes;
      low = existing.from;
      high = to;
    } else if (existing && to === existing.from - 1) {
      merged = ordered.concat(existing.logs);
      bytes += existing.bytes;
      low = from;
      high = existing.to;
    } else if (existing && from <= existing.to && to >= existing.from) {
      // Blocks answered again replace what was indexed for them, so a retried range never duplicates a log.
      const retained: Log[] = [];
      for (const log of existing.logs) {
        if (log.blockNumber >= from && log.blockNumber <= to) continue;
        retained.push(log);
        bytes += log.bytes;
      }
      merged = retained.concat(ordered).sort(byPosition);
      low = Math.min(from, existing.from);
      high = Math.max(to, existing.to);
    } else {
      merged = ordered;
    }
    low = Math.max(low, high - this.#config.logsWindow + 1);
    const first = firstAtBlock(merged, low);
    if (first > 0) {
      for (let index = 0; index < first; index += 1) bytes -= merged[index]?.bytes ?? 0;
      merged = merged.slice(first);
    }
    this.#set(key, { kind: "logs", from: low, to: high, logs: merged, at: now, bytes });
  }

  #value(key: string, kind: "latest" | "timed" | "immutable"): ValueEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry?.kind !== kind) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  #logs(key: string): LogsEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry?.kind !== "logs") return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  /** Put `entry` at the recent end, and drop the oldest entries past the count or byte cap. */
  #set(key: string, entry: Entry): void {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(key);
    }
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
    for (const [oldest, old] of this.#entries) {
      if (this.#entries.size <= this.#config.maxEntries && this.#bytes <= this.#config.maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= old.bytes;
    }
  }

  /** True when every endpoint that may serve `method` is known to hold `block`. */
  #holdsAll(method: string, block: number): boolean {
    const held = this.#source.held(method);
    return held !== undefined && held >= block;
  }
}

/** A cacheable call's plan, or undefined when the call is never cached. */
export function planFor(
  method: string,
  params: unknown,
  memo: WeakMap<object, Map<string, Plan | null>> | undefined = undefined,
): Plan | undefined {
  if (!memo || !Array.isArray(params)) return computePlan(method, params);
  let methods = memo.get(params);
  if (!methods) {
    methods = new Map();
    memo.set(params, methods);
  }
  if (methods.has(method)) return methods.get(method) ?? undefined;
  const plan = computePlan(method, params);
  methods.set(method, plan ?? null);
  return plan;
}

function computePlan(method: string, params: unknown): Plan | undefined {
  if (method === "eth_chainId") {
    return { kind: "immutable", method, key: "eth_chainId", params: [], guard: false };
  }
  if (!Array.isArray(params)) return undefined;
  const normalized = normalize(params) as unknown[];
  if (method === "eth_getLogs") return planLogs(normalized);
  if (BY_HASH.has(method)) {
    const key = coalesceKey(method, normalized);
    return key === undefined ? undefined : { kind: "immutable", method, key, params: normalized, guard: false };
  }
  const slot = BLOCK_SLOTS.get(method);
  if (!slot || normalized.length < slot.index) return undefined;
  if (method === "eth_call" && isPrecompileCall(normalized[0])) {
    // The precompile ignores the tag, so every spelling of it shares the key.
    const key = coalesceKey(method, withTag(normalized, slot.index, "latest"));
    return key === undefined ? undefined : { kind: "timed", method, key, params: normalized, guard: false };
  }
  const tag = readTag(normalized[slot.index], slot.implied);
  if (tag === undefined) return undefined;
  if (tag === "hash") {
    const key = coalesceKey(method, normalized);
    return key === undefined ? undefined : { kind: "immutable", method, key, params: normalized, guard: false };
  }
  const key = coalesceKey(method, withTag(normalized, slot.index, "latest"));
  if (key === undefined) return undefined;
  if (tag === "latest") {
    return slot.latest ? { kind: "latest", method, key, params: normalized, guard: false } : undefined;
  }
  const exact = coalesceKey(method, withTag(normalized, slot.index, toHex(tag)));
  if (exact === undefined) return undefined;
  return { kind: "number", method, key, params: normalized, block: tag, exact, guard: slot.state };
}

function planLogs(params: readonly unknown[]): Plan | undefined {
  const filter = params[0];
  if (!isRecord(filter) || params.length !== 1) return undefined;
  if (filter.blockHash !== undefined && filter.blockHash !== null) {
    const key = coalesceKey("eth_getLogs", params);
    return key === undefined ? undefined : { kind: "immutable", method: "eth_getLogs", key, params, guard: false };
  }
  const { fromBlock, toBlock, ...rest } = filter;
  const from = readBound(fromBlock);
  const to = readBound(toBlock);
  if (from === undefined || to === undefined) return undefined;
  const key = coalesceKey("eth_getLogs", rest);
  if (key === undefined) return undefined;
  return { kind: "logs", method: "eth_getLogs", key, params, guard: false, filter: rest, from, to };
}

/** `"latest"`, a block number, `"hash"` for an EIP-1898 hash, or undefined for a tag that is never cached. */
function readTag(tag: unknown, implied: boolean): "latest" | "hash" | number | undefined {
  if (tag === undefined) return implied ? "latest" : undefined;
  if (tag === "latest") return "latest";
  if (typeof tag === "string") {
    const block = parseQuantity(tag);
    return block === null ? undefined : block;
  }
  if (!isRecord(tag)) return undefined;
  if (typeof tag.blockHash === "string") return "hash";
  return readTag(tag.blockNumber, false);
}

/** A log filter bound: `"latest"` (given or omitted), `"earliest"` as 0, or a block number. */
function readBound(bound: unknown): Bound | undefined {
  if (bound === undefined || bound === null || bound === "latest") return "latest";
  if (bound === "earliest") return 0;
  if (typeof bound !== "string") return undefined;
  const block = parseQuantity(bound);
  return block === null ? undefined : block;
}

/** `params` with the block tag at `index` replaced by `tag`, added when it was implied. Later params stay. */
function withTag(params: readonly unknown[], index: number, tag: string): unknown[] {
  const next = params.slice();
  next[index] = tag;
  return next;
}

/** The `blockNumber` of a block or transaction result, or null when it has none. */
function blockOf(result: unknown): number | null {
  if (!isRecord(result)) return null;
  const field = "number" in result ? result.number : result.blockNumber;
  return parseQuantity(field);
}

function parseLogs(result: readonly unknown[], copyResults: boolean): Log[] | undefined {
  const logs: Log[] = [];
  for (const item of result) {
    if (!isRecord(item)) return undefined;
    const blockNumber = parseQuantity(item.blockNumber);
    if (blockNumber === null) return undefined;
    const value = copyResults ? (copy(item) as Record<string, unknown>) : item;
    logs.push({
      blockNumber,
      logIndex: parseQuantity(item.logIndex) ?? 0,
      value,
      bytes: sizeOf(value),
    });
  }
  return logs;
}

/** Logs in `[from, to]`, in block then log index order, copied unless the caller opted into shared results. */
function selectLogs(logs: readonly Log[], from: number, to: number, copyResults: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = firstAtBlock(logs, from); index < logs.length; index += 1) {
    const log = logs[index];
    if (!log || log.blockNumber > to) break;
    out.push(copyResults ? (copy(log.value) as Record<string, unknown>) : log.value);
  }
  return out;
}

/** First log at or after `block`, using the index's block/log-index ordering. */
function firstAtBlock(logs: readonly Log[], block: number): number {
  let low = 0;
  let high = logs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((logs[middle]?.blockNumber ?? block) < block) low = middle + 1;
    else high = middle;
  }
  return low;
}

function byPosition(left: Log, right: Log): number {
  return left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;
}

function inOrder(logs: readonly Log[]): boolean {
  for (let index = 1; index < logs.length; index += 1) {
    const previous = logs[index - 1];
    const current = logs[index];
    if (previous && current && byPosition(previous, current) > 0) return false;
  }
  return true;
}

function totalBytes(logs: readonly Log[]): number {
  let bytes = 0;
  for (const log of logs) bytes += log.bytes;
  return bytes;
}

/** A deep copy of JSON data with every hex string lower-cased, so spellings of one address or word share a key. */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return HEX.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

/** A deep copy of JSON data. Results are plain data, so a structural copy is enough and fast. */
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = copy(value[key]);
    return out;
  }
  return value;
}

/** Approximate bytes of JSON data in memory: UTF-16 strings plus an allowance per value. */
function sizeOf(value: unknown): number {
  if (typeof value === "string") return 16 + value.length * 2;
  if (Array.isArray(value)) {
    let total = 16;
    for (const item of value) total += sizeOf(item);
    return total;
  }
  if (isRecord(value)) {
    let total = 32;
    for (const key of Object.keys(value)) total += key.length * 2 + sizeOf(value[key]);
    return total;
  }
  return 8;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
