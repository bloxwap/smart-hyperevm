/**
 * Per-endpoint memory: latency, errors, in-flight calls, and the newest head.
 * @module
 */

import type { EndpointSnapshot } from "./_events.ts";
import {
  type MethodStat,
  type ScoreConfig,
  defaultScoreConfig,
  emptyStat,
  endpointScore,
  observe,
  observeLiveness,
} from "./_score.ts";

/** Identity of an endpoint the transport can call. */
export interface RankedEndpoint {
  readonly id: string;
  readonly url: string;
}

/** A concrete endpoint the scoreboard can rank. */
export interface ScoreboardEndpoint extends RankedEndpoint {
  weight: number;
  index: number;
  supports: (method: string) => boolean;
}

interface EndpointState extends ScoreboardEndpoint {
  /** Deadlines of the calls in flight. A call past its deadline no longer counts, whether or not it ended. */
  inflight: Set<{ readonly until: number }>;
  head: number | null;
  headAt: number;
  global: MethodStat;
  methods: Map<string, MethodStat>;
}

/** Blocks a head may lead the other endpoints' median before it is ignored. */
export const DEFAULT_MAX_AHEAD = 1_000;

/**
 * Generous ceiling on chain growth. HyperEVM makes about one small block per second.
 * Used to carry an older head forward before comparing it with a newer one.
 */
const MAX_BLOCKS_PER_SECOND = 2;

export interface ScoreboardOptions {
  perMethod: boolean;
  headLag: boolean;
  maxLag: number;
  staleMs: number;
  /** Default: {@link DEFAULT_MAX_AHEAD}. */
  maxAhead?: number | undefined;
  config?: ScoreConfig | undefined;
  now: () => number;
  /** Ejected endpoints. `pick` skips them unless every candidate is ejected. */
  ejected?: ((id: string) => boolean) | undefined;
}

/** Picks an endpoint and records what happened after the call. */
export class Scoreboard {
  readonly #endpoints: EndpointState[];
  readonly #options: ScoreboardOptions;

  constructor(endpoints: readonly ScoreboardEndpoint[], options: ScoreboardOptions) {
    this.#endpoints = endpoints.map((endpoint) => ({
      ...endpoint,
      inflight: new Set(),
      head: null,
      headAt: 0,
      global: emptyStat(),
      methods: new Map(),
    }));
    this.#options = options;
  }

  /** Lowest score, or the better of two randomly drawn endpoints. Ejected endpoints are a last resort. */
  pick(
    method: string,
    exclude: ReadonlySet<string>,
    mode: "best" | "p2c",
    random: () => number,
  ): RankedEndpoint | undefined {
    const eligible = this.#endpoints.filter((endpoint) => !exclude.has(endpoint.id) && endpoint.supports(method));
    const ejected = this.#options.ejected;
    const closed = ejected ? eligible.filter((endpoint) => !ejected(endpoint.id)) : eligible;
    const candidates = closed.length > 0 ? closed : eligible;
    const chosen =
      candidates.length === 0
        ? undefined
        : candidates.length === 1 || mode === "best"
          ? this.#best(candidates, method)
          : this.#p2c(candidates, method, random);
    if (!chosen) return undefined;
    return { id: chosen.id, url: chosen.url };
  }

  /**
   * Count a call in flight for at most `ttlMs`. Returns the function that ends it. Calling that again does nothing.
   * The cap matters when the runtime drops the call's own cleanup, as Workers does with a cancelled invocation.
   * Expired calls are collected here too, since a lone candidate is picked without being scored.
   */
  begin(id: string, ttlMs: number): () => void {
    const endpoint = this.#require(id);
    this.#inflight(endpoint);
    const call = { until: this.#options.now() + ttlMs };
    endpoint.inflight.add(call);
    return (): void => {
      endpoint.inflight.delete(call);
    };
  }

  /** Calls kept for `id`, expired ones included. Tests use this to check that expired calls are collected. */
  held(id: string): number {
    return this.#require(id).inflight.size;
  }

  success(id: string, method: string, latencyMs: number, sampleLatency: boolean): void {
    const endpoint = this.#require(id);
    const config = this.#config();
    if (!sampleLatency) {
      observeLiveness(endpoint.global, true, 0, config);
      return;
    }
    observe(endpoint.global, latencyMs, true, config);
    observe(this.#method(endpoint, method), latencyMs, true, config);
  }

  failure(id: string, method: string, latencyMs: number, sampleLatency: boolean, penaltyMs: number): void {
    const endpoint = this.#require(id);
    const config = this.#config();
    if (!sampleLatency) {
      observeLiveness(endpoint.global, false, penaltyMs, config);
      observeLiveness(this.#method(endpoint, method), false, penaltyMs, config);
      return;
    }
    observe(endpoint.global, latencyMs, false, config);
    observe(this.#method(endpoint, method), latencyMs, false, config);
  }

  /**
   * Record a block number. Returns lag behind the best believed head.
   * `trusted` is false when no reference is believed or this head is ignored as implausible.
   */
  noteHead(id: string, head: number): { best: number; lag: number; trusted: boolean } {
    const endpoint = this.#require(id);
    const now = this.#options.now();
    endpoint.head = head;
    endpoint.headAt = now;
    const view = this.#heads(now);
    const best = view.best ?? head;
    return { best, lag: Math.max(0, best - head), trusted: view.best !== null && !view.liars.has(endpoint) };
  }

  /**
   * How long to wait before cloning an idempotent read.
   * Cold endpoints use `minDelay`. After a few samples, wait until the call is slower than `multiplier` times the tail.
   */
  hedgeDelay(id: string, method: string, minDelay: number, multiplier: number): number {
    const endpoint = this.#require(id);
    const stat = endpoint.methods.get(method) ?? endpoint.global;
    if (stat.n < 3) return minDelay;
    const tail = stat.tail > 0 ? stat.tail : stat.ewma;
    const scaled = tail * multiplier;
    return scaled > minDelay ? scaled : minDelay;
  }

  snapshot(method: string): Omit<EndpointSnapshot, "quarantined">[] {
    const view = this.#heads(this.#options.now());
    return this.#endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      weight: endpoint.weight,
      inflight: this.#inflight(endpoint),
      head: endpoint.head,
      lag: this.#lag(endpoint, view),
      score: this.#score(endpoint, method),
      methods: Object.fromEntries([
        ["*", copyStat(endpoint.global)],
        ...[...endpoint.methods.entries()].map(([name, stat]) => [name, copyStat(stat)]),
      ]),
    }));
  }

  #require(id: string): EndpointState {
    const endpoint = this.#endpoints.find((item) => item.id === id);
    if (!endpoint) throw new Error(`Unknown HyperEVM endpoint: ${id}`);
    return endpoint;
  }

  #method(endpoint: EndpointState, method: string): MethodStat {
    const existing = endpoint.methods.get(method);
    if (existing) return existing;
    const created = emptyStat();
    endpoint.methods.set(method, created);
    return created;
  }

  #score(endpoint: EndpointState, method: string): number {
    return endpointScore({
      global: endpoint.global,
      method: endpoint.methods.get(method),
      perMethod: this.#options.perMethod,
      inflight: this.#inflight(endpoint),
      lagPenalty: this.#lagPenalty(endpoint),
      weight: endpoint.weight,
      config: this.#options.config ?? defaultScoreConfig,
    });
  }

  /** Calls in flight that are still inside their deadline. Expired ones are dropped. */
  #inflight(endpoint: EndpointState): number {
    const now = this.#options.now();
    for (const call of endpoint.inflight) if (call.until <= now) endpoint.inflight.delete(call);
    return endpoint.inflight.size;
  }

  /** Null when there is no head, no believed reference, or this endpoint's head is ignored. */
  #lag(endpoint: EndpointState, view: HeadView): number | null {
    if (endpoint.head === null || view.best === null || view.liars.has(endpoint)) return null;
    return Math.max(0, view.best - endpoint.head);
  }

  #config(): ScoreConfig {
    return this.#options.config ?? defaultScoreConfig;
  }

  #lagPenalty(endpoint: EndpointState): number {
    if (!this.#options.headLag) return 1;
    const view = this.#heads(this.#options.now());
    if (endpoint.head !== null && view.best !== null && view.liars.has(endpoint)) {
      // A head the others cannot corroborate is broken, not best. Score it as if it lagged by as much as it leads.
      return 1 + this.#config().lagWeight * (endpoint.head - view.best);
    }
    const lag = this.#lag(endpoint, view);
    if (lag === null || lag <= this.#options.maxLag) return 1;
    return 1 + this.#config().lagWeight * (lag - this.#options.maxLag);
  }

  /**
   * The reference head, and the endpoints whose heads are ignored.
   *
   * A fresh head is implausible when it leads the median of the other fresh heads by more than `maxAhead`.
   * Older heads are carried forward at {@link MAX_BLOCKS_PER_SECOND} before the comparison. The reference is
   * the highest head that is not implausible, so one broken endpoint cannot make every honest node look behind.
   *
   * One fresh head is its own reference. Two fresh heads more than `maxAhead` apart leave no reference:
   * either one could be broken, so lag stops counting until a third head breaks the tie.
   * With three or more the majority wins, so a leader is ignored only when most of the others agree it is too far ahead.
   */
  #heads(now: number): HeadView {
    const fresh: HeadSample[] = [];
    for (const endpoint of this.#endpoints) {
      if (endpoint.head === null) continue;
      if (now - endpoint.headAt > this.#options.staleMs) continue;
      fresh.push({ endpoint, head: endpoint.head, at: endpoint.headAt });
    }
    const maxAhead = this.#options.maxAhead ?? DEFAULT_MAX_AHEAD;
    const liars = new Set<EndpointState>();
    for (const sample of fresh) {
      const anchor = peerMedian(sample, fresh);
      if (anchor !== null && sample.head > anchor + maxAhead) liars.add(sample.endpoint);
    }
    if (fresh.length === 2 && liars.size > 0) return { best: null, liars: new Set() };
    let best: number | null = null;
    for (const sample of fresh) {
      if (liars.has(sample.endpoint)) continue;
      if (best === null || sample.head > best) best = sample.head;
    }
    return { best, liars };
  }

  #better(left: EndpointState, right: EndpointState, method: string): EndpointState {
    const leftScore = this.#score(left, method);
    const rightScore = this.#score(right, method);
    if (leftScore < rightScore) return left;
    if (rightScore < leftScore) return right;
    return left.index <= right.index ? left : right;
  }

  #best(candidates: readonly EndpointState[], method: string): EndpointState | undefined {
    let best: EndpointState | undefined;
    for (const candidate of candidates) {
      if (!best || this.#better(candidate, best, method) === candidate) best = candidate;
    }
    return best;
  }

  #p2c(candidates: readonly EndpointState[], method: string, random: () => number): EndpointState | undefined {
    const first = candidates[draw(random, candidates.length)];
    if (!first) return undefined;
    let secondIndex = draw(random, candidates.length);
    if (candidates[secondIndex] === first) secondIndex = (candidates.indexOf(first) + 1) % candidates.length;
    const second = candidates[secondIndex] ?? first;
    return this.#better(first, second, method);
  }
}

interface HeadSample {
  readonly endpoint: EndpointState;
  readonly head: number;
  readonly at: number;
}

interface HeadView {
  /** Highest believed fresh head, or null when none is believed. */
  readonly best: number | null;
  /** Endpoints whose fresh head is ignored as implausible. */
  readonly liars: ReadonlySet<EndpointState>;
}

/** Median of the other fresh heads, each carried forward to when `sample` was taken. Upper middle on an even count. */
function peerMedian(sample: HeadSample, fresh: readonly HeadSample[]): number | null {
  const others = fresh
    .filter((other) => other !== sample)
    .map((other) => other.head + (Math.max(0, sample.at - other.at) / 1_000) * MAX_BLOCKS_PER_SECOND)
    .sort((left, right) => left - right);
  return others[Math.floor(others.length / 2)] ?? null;
}

function copyStat(stat: MethodStat): { ewma: number; tail: number; error: number; n: number } {
  return { ewma: stat.ewma, tail: stat.tail, error: stat.error, n: stat.n };
}

function draw(random: () => number, length: number): number {
  const scaled = Math.floor(random() * length);
  if (scaled < 0) return 0;
  if (scaled >= length) return length - 1;
  return scaled;
}

/** Parse a hex quantity such as an `eth_blockNumber` result. */
export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const parsed = Number.parseInt(value, 16);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Pull the chain head out of a JSON-RPC result when the call asked for it.
 * Only `eth_blockNumber`, and `eth_getBlockByNumber` with the `"latest"` tag, count.
 * A block fetched by hash or by number is history, not the head.
 */
export function blockNumberFromResult(method: string, result: unknown, params?: unknown): number | null {
  if (method === "eth_blockNumber") return parseQuantity(result);
  if (method !== "eth_getBlockByNumber") return null;
  if (!Array.isArray(params) || params[0] !== "latest") return null;
  if (typeof result !== "object" || result === null || !("number" in result)) return null;
  return parseQuantity(result.number);
}
