/**
 * Per-endpoint request budgets.
 *
 * Each budgeted endpoint has a token bucket that holds up to `burst` tokens and
 * refills at `rps` tokens per second. Every upstream request spends one: calls,
 * retries, hedges, chain checks, and head probes. Buckets refill from the clock
 * when they are read, so there is no timer.
 * @module
 */

/** A request budget for one endpoint, or the default for every endpoint. */
export interface BudgetOptions {
  /** Sustained requests per second, above 0. */
  rps: number;
  /** Requests that may go at once after a quiet spell, at least 1. Default: `max(1, ceil(rps * 2))`. */
  burst?: number | undefined;
}

/** A validated budget. */
export interface BudgetConfig {
  rps: number;
  burst: number;
}

interface Bucket {
  readonly rps: number;
  readonly burst: number;
  tokens: number;
  /** When `tokens` was last brought up to date. Undefined until the bucket is first read. */
  at: number | undefined;
}

/** `max(1, ceil(rps * 2))`: two seconds of traffic, and always room for one request. */
export function defaultBurst(rps: number): number {
  return Math.max(1, Math.ceil(rps * 2));
}

/** Validate the transport-wide `budget` option. */
export function resolveDefaultBudget(value: BudgetOptions | false | undefined): BudgetConfig | false | undefined {
  if (value === false || value === undefined) return value;
  return validBudget(value.rps, value.burst, "hyperevm() budget");
}

/**
 * The budget for one endpoint: its own `rps` and `burst` over the transport default.
 * A `burst` without `rps` keeps the default rate. A transport `budget` of `false` turns every budget off.
 */
export function resolveEndpointBudget(
  endpoint: { rps?: number | undefined; burst?: number | undefined },
  fallback: BudgetConfig | false | undefined,
  where: string,
): BudgetConfig | undefined {
  if (fallback === false) return undefined;
  if (endpoint.rps === undefined && endpoint.burst === undefined) return fallback;
  const rps = endpoint.rps ?? fallback?.rps;
  if (rps === undefined) throw new Error(`${where}.burst needs an rps, on the endpoint or in budget.`);
  const burst = endpoint.burst ?? (endpoint.rps === undefined ? fallback?.burst : undefined);
  return validBudget(rps, burst, where);
}

function validBudget(rps: number, burst: number | undefined, where: string): BudgetConfig {
  if (!(Number.isFinite(rps) && rps > 0)) throw new Error(`${where}.rps must be a finite number above 0.`);
  if (burst !== undefined && !(Number.isFinite(burst) && burst >= 1)) {
    throw new Error(`${where}.burst must be a finite number of at least 1.`);
  }
  return { rps, burst: burst ?? defaultBurst(rps) };
}

/**
 * Token buckets keyed by endpoint label. Endpoints without a budget are unlimited and hold no bucket.
 * One factory keeps one set, so every instance it builds spends from the same buckets: a provider's
 * limit is per caller, not per viem client.
 */
export class Budgets {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Give `id` a bucket, full. An existing bucket is kept, so a later instance does not refill it. */
  configure(id: string, config: BudgetConfig | undefined): void {
    if (!config || this.#buckets.has(id)) return;
    this.#buckets.set(id, { rps: config.rps, burst: config.burst, tokens: config.burst, at: undefined });
  }

  /** True when `id` is unlimited or holds a whole token. */
  has(id: string): boolean {
    const bucket = this.#refilled(id);
    return bucket === undefined || bucket.tokens >= 1;
  }

  /** Spend one token. An unlimited endpoint spends nothing. */
  take(id: string): void {
    const bucket = this.#refilled(id);
    if (bucket) bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  /** Whole tokens left, or null when `id` is unlimited. */
  remaining(id: string): number | null {
    const bucket = this.#refilled(id);
    return bucket === undefined ? null : Math.floor(bucket.tokens);
  }

  /** Milliseconds until the first of `ids` holds a whole token. Zero when one already does. */
  refillMs(ids: Iterable<string>): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const bucket = this.#refilled(id);
      if (bucket === undefined || bucket.tokens >= 1) return 0;
      soonest = Math.min(soonest, Math.ceil(((1 - bucket.tokens) * 1_000) / bucket.rps));
    }
    return Number.isFinite(soonest) ? soonest : 0;
  }

  #refilled(id: string): Bucket | undefined {
    const bucket = this.#buckets.get(id);
    if (!bucket) return undefined;
    const now = this.#now();
    if (bucket.at !== undefined && now > bucket.at) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + ((now - bucket.at) * bucket.rps) / 1_000);
    }
    if (bucket.at === undefined || now > bucket.at) bucket.at = now;
    return bucket;
  }
}
