/**
 * Racing an idempotent read across the best-scored endpoints at once.
 *
 * The first answer wins. Losers are not cancelled: they finish under their own
 * attempt deadline, so every race also re-measures the runners-up and the
 * scores keep following whichever endpoint is fastest now. A loser the caller
 * aborts is not an endpoint failure, and its in-flight count ends with it.
 * @module
 */

import { toError } from "./_methods.ts";

/** Endpoints raced at once when `race` is `true`. */
export const DEFAULT_RACE_WIDTH = 2;

export interface RaceOptions {
  /** Endpoints sent each idempotent read at once, at least 2. Capped at the endpoints that can serve it. Default: 2. */
  width?: number | undefined;
}

/** One attempt in a race. Matches the transport's in-flight attempt. */
export interface RaceCall {
  promise: Promise<unknown>;
  cancel: () => void;
  cancelled: () => boolean;
}

/** Where racers come from. The transport backs this with its scoreboard, breaker, and chain gates. */
export interface RacePool<T extends { readonly id: string }> {
  /** Best remaining endpoint by score, outside `skip`. */
  next: (skip: ReadonlySet<string>) => T | undefined;
  /** `"ready"` to race now, `"unverified"` when its chain check has not passed, else `"unavailable"`. */
  state: (endpoint: T) => "ready" | "unverified" | "unavailable";
  /** Start the chain check of an unverified endpoint in the background, so a later race can use it. */
  verify: (endpoint: T) => void;
}

/** Racers after the lead, or 0 when `race` is off. Undefined races `DEFAULT_RACE_WIDTH`. */
export function resolveRace(value: boolean | RaceOptions | undefined): number {
  if (value === false) return 0;
  const width = typeof value === "object" ? (value.width ?? DEFAULT_RACE_WIDTH) : DEFAULT_RACE_WIDTH;
  if (!Number.isInteger(width) || width < 2) {
    throw new Error(`hyperevm() race.width must be an integer of at least 2, got ${width}.`);
  }
  return width - 1;
}

/**
 * Up to `count` endpoints to race beside the lead, best score first. Unverified endpoints are skipped, not awaited,
 * so the race starts at once. At most `count` of them get a background check per call.
 */
export function pickRacers<T extends { readonly id: string }>(
  count: number,
  exclude: ReadonlySet<string>,
  pool: RacePool<T>,
): T[] {
  const racers: T[] = [];
  const skip = new Set(exclude);
  let checks = 0;
  while (racers.length < count) {
    const candidate = pool.next(skip);
    if (!candidate) break;
    skip.add(candidate.id);
    const state = pool.state(candidate);
    if (state === "ready") {
      racers.push(candidate);
    } else if (state === "unverified" && checks < count) {
      checks += 1;
      pool.verify(candidate);
    }
  }
  return racers;
}

/**
 * Settle with the first success among `calls`. A failure waits for the others unless `decisive` says the
 * failover loop would stop on it anyway (a revert, a caller abort), since every endpoint would answer the same.
 * When every call fails, reject with the last error and hand the earlier ones to `failed`.
 * `cancel()` only marks the race as lost. Its calls keep running so their latency is still scored.
 */
export function raceCalls(
  calls: readonly RaceCall[],
  decisive: (error: Error) => boolean,
  failed: (errors: readonly Error[]) => void,
): RaceCall {
  let settled = false;
  let cancelled = false;
  let pending = calls.length;
  const errors: Error[] = [];
  const promise = new Promise<unknown>((resolve, reject) => {
    for (const call of calls) {
      call.promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        },
        (error: unknown) => {
          pending -= 1;
          if (settled) return;
          const wrapped = toError(error);
          if (pending > 0 && !decisive(wrapped)) {
            errors.push(wrapped);
            return;
          }
          settled = true;
          failed(errors);
          reject(wrapped);
        },
      );
    }
  });
  return {
    promise,
    cancel(): void {
      cancelled = true;
    },
    cancelled: (): boolean => cancelled,
  };
}
