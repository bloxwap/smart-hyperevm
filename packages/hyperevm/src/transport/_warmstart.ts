/**
 * Warm start: learned scores kept between sessions, so a fresh client does not start cold.
 *
 * A snapshot holds each endpoint's latency, tail, and error books under its public label, never a URL. Heads,
 * breaker state, and chain checks are not saved. They describe the moment, so a new session re-establishes them.
 * A restored book is a prior, not a measurement: it counts as at most two samples, so its score blends back toward
 * `priorMs` and it never sets a hedge delay, and the endpoint's first live sample replaces it.
 * @module
 */

import type { HyperevmEvent } from "./_events.ts";
import { toError } from "./_methods.ts";
import type { MethodStat } from "./_score.ts";
import type { Scoreboard } from "./_scoreboard.ts";

/** Snapshots and books older than this are ignored. */
export const DEFAULT_SCORE_MAX_AGE_MS = 3_600_000;

/** Shortest gap between two saves. */
export const DEFAULT_SCORE_SAVE_INTERVAL_MS = 10_000;

/** Samples a restored book counts as. Below `confidenceSamples` and the 3 a hedge delay needs. */
const RESTORED_SAMPLES = 2;

/** Books read per endpoint, the global one included. Storage is untrusted, so a snapshot cannot grow the maps. */
const MAX_RESTORED_BOOKS = 32;

/** Longest JSON string `restoreScores` parses. A full pool with every method book is far smaller. */
const MAX_SNAPSHOT_CHARS = 262_144;

/** How far in the future a snapshot may claim to be from, for clocks that disagree. */
const MAX_CLOCK_SKEW_MS = 60_000;

const METHOD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** One stored book: a {@link MethodStat}, plus when a book carried over from an older session was measured. */
export interface ScoreBook extends MethodStat {
  /**
   * When the book was measured, if before `savedAt`. A restored book no live sample replaced keeps the time it was
   * first measured, so saving it again does not make it fresh.
   */
  at?: number | undefined;
}

/** Learned scores, as `value.scores()` returns them and `value.restoreScores()` takes them. Plain JSON. */
export interface ScoreSnapshot {
  version: 1;
  /** `now()` when the snapshot was taken. */
  savedAt: number;
  /** Books by endpoint label, then by method. `"*"` is the endpoint's global book. */
  endpoints: Record<string, Record<string, ScoreBook>>;
}

/** Where the `persist` option keeps scores. */
export interface ScorePersistence {
  /** Return the stored snapshot, its JSON string, or nothing. Runs once, on the instance's first request. */
  load(): unknown | Promise<unknown>;
  /** Store `snapshot`. Called at most every `saveInterval`, and on `close()`. */
  save(snapshot: ScoreSnapshot): void | Promise<void>;
  /** Ignore snapshots and books older than this many milliseconds, by `now`. Default: 3600000. */
  maxAge?: number | undefined;
  /** Milliseconds between saves, at least. Default: 10000. */
  saveInterval?: number | undefined;
}

interface WarmStartOptions {
  persistence: ScorePersistence | undefined;
  /** Endpoint labels. Books for any other id are ignored. */
  ids: readonly string[];
  /** Largest latency a restored book may hold: the per-attempt deadline, since no live sample can be slower. */
  latencyCapMs: number;
  /**
   * How long a pending `load` holds saves back. On Workers a load started by an invocation that ended never
   * settles, and saves would stop for good. Past this, saves resume, and a load that lands later still seeds.
   */
  loadTimeoutMs: number;
  now: () => number;
  emit: (event: HyperevmEvent) => void;
}

/** Restores and saves one instance's books. */
export class WarmStart {
  readonly #board: Scoreboard;
  readonly #options: WarmStartOptions;
  readonly #maxAgeMs: number;
  readonly #saveIntervalMs: number;
  /** `"idle"` before the first request, `"loading"` while `load` runs, `"ready"` once it settled. */
  #load: "idle" | "loading" | "ready" = "idle";
  #lastSaveAt = 0;
  #loadStartedAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the armed timer should have fired. */
  #dueAt = 0;
  #closed = false;

  constructor(board: Scoreboard, options: WarmStartOptions) {
    this.#board = board;
    this.#options = options;
    const persistence = options.persistence;
    this.#maxAgeMs = nonNegative(persistence?.maxAge, "maxAge", DEFAULT_SCORE_MAX_AGE_MS);
    this.#saveIntervalMs = nonNegative(persistence?.saveInterval, "saveInterval", DEFAULT_SCORE_SAVE_INTERVAL_MS);
  }

  scores(): ScoreSnapshot {
    const endpoints = new Map<string, [string, ScoreBook][]>();
    for (const { id, method, stat, at } of this.#board.books()) {
      const books = endpoints.get(id) ?? [];
      books.push([method, at === undefined ? stat : { ...stat, at }]);
      endpoints.set(id, books);
    }
    // Built from entries: a label or method named `__proto__` must stay an own property.
    return {
      version: 1,
      savedAt: this.#options.now(),
      endpoints: Object.fromEntries([...endpoints].map(([id, books]) => [id, Object.fromEntries(books)])),
    };
  }

  /** True when the snapshot seeded at least one book. */
  restore(input: unknown): boolean {
    return this.#apply(input) === true;
  }

  /**
   * Runs on every request. The first one starts `load`. When `load` returns a promise, this returns a resolved one
   * for the request to await, so a load that already settled seeds the books before the first pick. A slower load
   * lands whenever it settles and never holds the call.
   */
  touch(): Promise<void> | undefined {
    const persistence = this.#options.persistence;
    if (!persistence || this.#closed) return undefined;
    if (this.#load !== "idle") {
      this.#schedule();
      return undefined;
    }
    this.#load = "loading";
    this.#lastSaveAt = Date.now();
    this.#loadStartedAt = this.#lastSaveAt;
    this.#schedule();
    let loaded: unknown;
    try {
      loaded = persistence.load();
    } catch (error) {
      this.#loadFailed(error);
      return undefined;
    }
    if (!isThenable(loaded)) {
      this.#loaded(loaded);
      return undefined;
    }
    Promise.resolve(loaded).then(
      (value) => this.#loaded(value),
      (error: unknown) => this.#loadFailed(error),
    );
    return Promise.resolve();
  }

  /** Save now and stop the timer. Calling it again does nothing. */
  close(): void {
    if (this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#save();
    this.#closed = true;
  }

  /** True when it seeded a book, false when it was valid but seeded nothing, undefined when it is not a snapshot. */
  #apply(input: unknown): boolean | undefined {
    const snapshot = readSnapshot(input);
    if (!snapshot) return undefined;
    const now = this.#options.now();
    if (!this.#fresh(snapshot.savedAt, now)) return false;
    let seeded = false;
    for (const id of this.#options.ids) {
      // A plain read would find `Object.prototype` under `__proto__`.
      const books: unknown = Object.getOwnPropertyDescriptor(snapshot.endpoints, id)?.value;
      if (!isRecord(books)) continue;
      for (const method of Object.keys(books).slice(0, MAX_RESTORED_BOOKS)) {
        if (method !== "*" && !METHOD_NAME.test(method)) continue;
        const book = readBook(books[method], snapshot.savedAt, this.#options.latencyCapMs);
        if (!book || !this.#fresh(book.at, now)) continue;
        if (this.#board.seed(id, method, book.stat, book.at)) seeded = true;
      }
    }
    return seeded;
  }

  #fresh(at: number, now: number): boolean {
    const age = now - at;
    return age <= this.#maxAgeMs && age >= -MAX_CLOCK_SKEW_MS;
  }

  #loaded(value: unknown): void {
    this.#load = "ready";
    // Books with live samples are never replaced, so a load that lands after its deadline is still safe to apply.
    // Empty storage is not an error.
    if (this.#closed || value === undefined || value === null) return;
    if (this.#apply(value) === undefined) this.#report("load", new Error("The stored score snapshot is not valid."));
  }

  #loadFailed(error: unknown): void {
    this.#load = "ready";
    this.#report("load", toError(error));
  }

  #schedule(): void {
    if (this.#closed) return;
    if (this.#timer !== undefined) {
      // Workers cancel an invocation's timers when it ends, and nothing clears `#timer` then. Past its due time,
      // arm it again from this request.
      if (Date.now() < this.#dueAt) return;
      clearTimeout(this.#timer);
    }
    const wait = Math.max(0, this.#lastSaveAt + this.#saveIntervalMs - Date.now());
    this.#dueAt = Date.now() + wait;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#save();
    }, wait);
    // Saving is not the call's work. It should not keep a short-lived process alive.
    unrefTimer(this.#timer);
  }

  #save(): void {
    const persistence = this.#options.persistence;
    if (this.#load === "loading" && Date.now() - this.#loadStartedAt >= this.#options.loadTimeoutMs) {
      this.#load = "ready";
      this.#report("load", new Error(`The score load did not settle within ${this.#options.loadTimeoutMs}ms.`));
    }
    // Until the load settles, a save would overwrite stored books this instance has not read. The next request retries.
    if (!persistence || this.#load !== "ready") return;
    this.#lastSaveAt = Date.now();
    try {
      const pending = persistence.save(this.scores());
      if (isThenable(pending)) Promise.resolve(pending).then(undefined, (error: unknown) => this.#saveFailed(error));
    } catch (error) {
      this.#saveFailed(error);
    }
  }

  #saveFailed(error: unknown): void {
    this.#report("save", toError(error));
  }

  #report(operation: "load" | "save", error: Error): void {
    this.#options.emit({ type: "persist", operation, error });
  }
}

/**
 * A {@link ScorePersistence} that keeps the snapshot in `globalThis.localStorage` under `key`.
 * Where storage is missing or blocked (Workers, Node, React Native, some private modes) it loads and saves nothing.
 * It never throws, so a full or blocked storage fires no `persist` event.
 */
export function localStoragePersistence(key: string): ScorePersistence {
  return {
    load(): unknown {
      try {
        return localStorageOf()?.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    save(snapshot: ScoreSnapshot): void {
      try {
        localStorageOf()?.setItem(key, JSON.stringify(snapshot));
      } catch (error) {
        // Quota exceeded or storage blocked. The next session starts cold.
        void error;
      }
    },
  };
}

/** `globalThis.localStorage` when it looks usable. Reading it can throw in a sandboxed frame, so callers catch. */
function localStorageOf(): Pick<Storage, "getItem" | "setItem"> | undefined {
  const storage: unknown = Reflect.get(globalThis, "localStorage");
  if (typeof storage !== "object" || storage === null) return undefined;
  if (!("getItem" in storage) || typeof storage.getItem !== "function") return undefined;
  if (!("setItem" in storage) || typeof storage.setItem !== "function") return undefined;
  return storage as Pick<Storage, "getItem" | "setItem">;
}

/** The parts of a snapshot `restore` reads, or undefined when `input` is not a version 1 snapshot. */
function readSnapshot(input: unknown): { savedAt: number; endpoints: Record<string, unknown> } | undefined {
  let value = input;
  if (typeof value === "string") {
    if (value.length > MAX_SNAPSHOT_CHARS) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value) || value.version !== 1) return undefined;
  const { savedAt, endpoints } = value;
  if (!isFiniteNumber(savedAt) || !isRecord(endpoints)) return undefined;
  return { savedAt, endpoints };
}

/** A clamped book and when it was measured, or undefined when a field is missing or not a finite number. */
function readBook(raw: unknown, savedAt: number, capMs: number): { stat: MethodStat; at: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const { ewma, tail, error, n, at } = raw;
  if (!isFiniteNumber(ewma) || !isFiniteNumber(tail) || !isFiniteNumber(error) || !isFiniteNumber(n)) return undefined;
  if (n < 1 || (at !== undefined && !isFiniteNumber(at))) return undefined;
  return {
    stat: {
      ewma: clamp(ewma, 0, capMs),
      tail: clamp(tail, 0, capMs),
      error: clamp(error, 0, 1),
      n: Math.min(Math.floor(n), RESTORED_SAMPLES),
    },
    at: at === undefined ? savedAt : Math.min(at, savedAt),
  };
}

function nonNegative(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`hyperevm() persist.${name} must be a finite number of milliseconds, 0 or more, got ${value}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
