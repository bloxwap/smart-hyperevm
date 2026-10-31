/**
 * Per-endpoint circuit breaker.
 *
 * Consecutive endpoint failures eject an endpoint for a cooldown that doubles
 * on each ejection, up to a ceiling. A `Retry-After` header ejects at once for
 * the time the provider asked for. Routing skips ejected endpoints while any
 * other candidate remains. A healthy answer closes the circuit.
 * A head probe or chain check answering does not clear a streak that holds a
 * failed call: a node can answer `eth_blockNumber` while it hangs every read.
 * @module
 */

/** Consecutive endpoint failures that eject an endpoint. */
export const DEFAULT_BREAKER_THRESHOLD = 3;

/** First ejection length. Each later ejection doubles it. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 5_000;

/** Longest ejection, including one asked for by `Retry-After`. */
export const DEFAULT_BREAKER_MAX_COOLDOWN_MS = 60_000;

/** Resolved breaker settings. */
export interface BreakerConfig {
  enabled: boolean;
  threshold: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

/** What a failure did to the circuit, when it opened it. */
export interface Ejection {
  readonly failures: number;
  readonly cooldownMs: number;
}

interface Circuit {
  failures: number;
  callFailures: number;
  ejections: number;
  openUntil: number;
}

/** Tracks consecutive failures and ejection windows for every endpoint. */
export class Breaker {
  readonly #circuits = new Map<string, Circuit>();
  readonly #config: BreakerConfig;
  readonly #now: () => number;

  constructor(config: BreakerConfig, now: () => number) {
    this.#config = config;
    this.#now = now;
  }

  /** True while the endpoint is ejected. */
  isOpen(id: string): boolean {
    return this.remaining(id) > 0;
  }

  /** Milliseconds until the endpoint is eligible again. Zero when it is. */
  remaining(id: string): number {
    if (!this.#config.enabled) return 0;
    const circuit = this.#circuits.get(id);
    if (!circuit) return 0;
    return Math.max(0, circuit.openUntil - this.#now());
  }

  /**
   * Record a healthy answer. Returns true when this closed an ejected circuit.
   * A `probe` answer only clears a streak of probe failures.
   */
  success(id: string, probe = false): boolean {
    const circuit = this.#circuits.get(id);
    if (!circuit) return false;
    if (probe && circuit.callFailures > 0) return false;
    const restored = circuit.ejections > 0 || circuit.openUntil > 0;
    this.#circuits.delete(id);
    return this.#config.enabled && restored;
  }

  /** Record an endpoint failure. Returns the ejection when this one opened the circuit. */
  failure(id: string, retryAfterMs = 0, probe = false): Ejection | undefined {
    if (!this.#config.enabled) return undefined;
    const circuit = this.#circuit(id);
    circuit.failures += 1;
    if (!probe) circuit.callFailures += 1;
    const now = this.#now();
    const askedMs = Math.min(this.#config.maxCooldownMs, Math.max(0, retryAfterMs));
    if (now < circuit.openUntil) {
      circuit.openUntil = Math.max(circuit.openUntil, now + askedMs);
      return undefined;
    }
    const tripped = circuit.failures >= this.#config.threshold;
    if (!tripped && askedMs <= 0) return undefined;
    let cooldownMs = askedMs;
    if (tripped) {
      const backoff = this.#config.cooldownMs * 2 ** circuit.ejections;
      cooldownMs = Math.max(cooldownMs, Math.min(this.#config.maxCooldownMs, backoff));
      circuit.ejections += 1;
    }
    circuit.openUntil = now + cooldownMs;
    return { failures: circuit.failures, cooldownMs };
  }

  #circuit(id: string): Circuit {
    const existing = this.#circuits.get(id);
    if (existing) return existing;
    const created: Circuit = { failures: 0, callFailures: 0, ejections: 0, openUntil: 0 };
    this.#circuits.set(id, created);
    return created;
  }
}

/**
 * Milliseconds a `Retry-After` header on the error (or its causes) asks for.
 * viem's `HttpRequestError` carries the response headers. Zero when absent.
 */
export function retryAfterMs(error: unknown, now: number = Date.now()): number {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const value = headerValue(current, "retry-after");
    if (value !== undefined) return parseRetryAfter(value, now);
    current = "cause" in current ? current.cause : undefined;
  }
  return 0;
}

function headerValue(error: object, name: string): string | undefined {
  if (!("headers" in error)) return undefined;
  const headers = error.headers;
  if (typeof headers !== "object" || headers === null || !("get" in headers)) return undefined;
  if (typeof headers.get !== "function") return undefined;
  const value: unknown = headers.get(name);
  return typeof value === "string" ? value : undefined;
}

function parseRetryAfter(value: string, now: number): number {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1_000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at - now);
}
