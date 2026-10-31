/**
 * In-flight coalescing: identical concurrent reads share one upstream request.
 *
 * An entry lives only while its request is in flight, so the map is bounded by concurrency and nothing is cached.
 * Each caller waits under its own signal. The shared request is cancelled only once every waiting caller has
 * stopped waiting, and a cancelled entry leaves the map at once, so a later caller starts fresh.
 * @module
 */

/**
 * Idempotent methods that still never coalesce. A subscription belongs to one caller's socket, and a filter's
 * id and its polls are state on one node.
 */
const UNCOALESCED_METHODS: ReadonlySet<string> = new Set([
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
]);

/** True when concurrent identical calls of `method` may share one request. The caller passes its idempotency verdict. */
export function isCoalescableMethod(method: string, idempotent: boolean): boolean {
  return idempotent && !UNCOALESCED_METHODS.has(method);
}

/**
 * `method` plus params serialized with sorted object keys. A bigint is tagged so it never matches a string or a
 * number. Undefined when the params cannot be serialized (a cycle), in which case the call is not coalesced.
 */
export function coalesceKey(method: string, params: unknown): string | undefined {
  const parts: string[] = [];
  return writeValue(params, parts, new Set()) ? `${method}:${parts.join("")}` : undefined;
}

function writeValue(value: unknown, out: string[], path: Set<object>): boolean {
  if (value === undefined) {
    out.push("u");
    return true;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    out.push(JSON.stringify(value));
    return true;
  }
  if (typeof value === "number") {
    // `String` keeps NaN and Infinity apart from null, which JSON.stringify would merge.
    out.push(String(value));
    return true;
  }
  if (typeof value === "bigint") {
    out.push(`${value}n`);
    return true;
  }
  if (typeof value !== "object") {
    out.push(`<${typeof value}>`);
    return true;
  }
  if (path.has(value)) return false;
  path.add(value);
  let ok = true;
  const toJson: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    ok = writeValue(toJson.call(value), out, path);
  } else if (Array.isArray(value)) {
    out.push("[");
    for (let index = 0; index < value.length && ok; index += 1) {
      if (index > 0) out.push(",");
      ok = writeValue(value[index], out, path);
    }
    out.push("]");
  } else {
    out.push("{");
    const keys = Object.keys(value).sort();
    for (let index = 0; index < keys.length && ok; index += 1) {
      const key = keys[index] as string;
      if (index > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      ok = writeValue((value as Record<string, unknown>)[key], out, path);
    }
    out.push("}");
  }
  path.delete(value);
  return ok;
}

interface Entry {
  promise: Promise<unknown>;
  /** Present only when the shared request runs under a signal it can be cancelled with. */
  cancel: Cancel | undefined;
  /** Callers still waiting on it. */
  waiting: number;
  /** True once every caller has stopped waiting. */
  abandoned: boolean;
  /** Wall-clock time after which no caller joins, and joined callers stop waiting. */
  deadline: number;
}

/**
 * The controller behind every shared request started by callers with one signal. viem's HTTP transport batches by
 * signal, so a controller per request would put each read in a batch of its own. It aborts once each of its
 * requests in flight has been abandoned, which can only happen after that caller signal aborted.
 */
interface Cancel {
  controller: AbortController;
  live: Set<Entry>;
}

/**
 * Starts the shared request. It calls `progress` each time it starts an attempt, or before a wait of `waitMs`,
 * which keeps joined callers waiting another `maxWaitMs` from then.
 */
type Run = (signal: AbortSignal | undefined, progress: (waitMs?: number) => void) => Promise<unknown>;

/** One instance's table of shared in-flight reads. */
export class Coalescer {
  readonly #entries = new Map<string, Entry>();
  readonly #cancels = new WeakMap<AbortSignal, Cancel>();
  readonly #maxWaitMs: number;

  /**
   * `maxWaitMs` bounds how long a joined caller waits on another caller's request without news from it. On Workers
   * the invocation that started it can end and take its I/O and timers with it, so the shared promise may never
   * settle. A caller past the bound starts a fresh request, and the stuck one is never joined again. A request that
   * reports progress (a failover, a backoff) moves the bound out, so its callers do not leave it just as it retries.
   */
  constructor(maxWaitMs: number) {
    this.#maxWaitMs = maxWaitMs;
  }

  /** Shared requests in flight. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Join the in-flight request for `key`, or start one with `run`. `run` gets the signal the shared request must
   * honour: undefined when the first caller has none, since that request is never cancelled, and viem's HTTP batch
   * key then stays the shared default. Requests started under one caller signal get one signal between them, so
   * they still batch together. `onJoin` fires for a caller that joined an existing request.
   * A caller whose signal has already aborted neither joins nor starts one: `run` gets its signal, as uncoalesced.
   */
  request(key: string, signal: AbortSignal | undefined, run: Run, onJoin: () => void): Promise<unknown> {
    if (signal?.aborted) return run(signal, ignore);
    const existing = this.#entries.get(key);
    if (existing && Date.now() < existing.deadline) {
      onJoin();
      return this.#wait(key, existing, signal, () => this.request(key, signal, run, ignore));
    }
    return this.#wait(key, this.#start(key, signal, run), signal, undefined);
  }

  #start(key: string, signal: AbortSignal | undefined, run: Run): Entry {
    const cancel = signal === undefined ? undefined : this.#cancelFor(signal);
    const entry: Entry = {
      promise: Promise.resolve(),
      cancel,
      waiting: 0,
      abandoned: false,
      deadline: Date.now() + this.#maxWaitMs,
    };
    const progress = (waitMs = 0): void => {
      entry.deadline = Math.max(entry.deadline, Date.now() + waitMs + this.#maxWaitMs);
    };
    let started: Promise<unknown>;
    try {
      started = run(cancel?.controller.signal, progress);
    } catch (error) {
      started = Promise.reject(error);
    }
    cancel?.live.add(entry);
    entry.promise = started.finally(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      if (cancel) {
        cancel.live.delete(entry);
        this.#cancelIfAbandoned(cancel);
      }
    });
    // Every caller may have stopped waiting before it settles. Nobody else observes the shared rejection.
    entry.promise.catch(ignore);
    this.#entries.set(key, entry);
    return entry;
  }

  /** Wait on `entry` under the caller's own signal. A joined caller passes `retry`, which runs at the deadline. */
  #wait(
    key: string,
    entry: Entry,
    signal: AbortSignal | undefined,
    retry: (() => Promise<unknown>) | undefined,
  ): Promise<unknown> {
    entry.waiting += 1;
    if (!signal && !retry) return entry.promise;
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (then: () => void): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        then();
      };
      const onAbort = (): void =>
        settle(() => {
          this.#leave(key, entry);
          reject(abortReason(signal));
        });
      signal?.addEventListener("abort", onAbort, { once: true });
      const arm = (): void => {
        if (!retry) return;
        timer = setTimeout(
          () => {
            // The shared request moved its deadline out since this timer was armed.
            if (Date.now() < entry.deadline) {
              arm();
              return;
            }
            settle(() => {
              if (this.#entries.get(key) === entry) this.#entries.delete(key);
              this.#leave(key, entry);
              retry().then(resolve, reject);
            });
          },
          Math.max(0, entry.deadline - Date.now()),
        );
        // The shared request carries the work. This timer only bounds the wait on it.
        unrefTimer(timer);
      };
      arm();
      entry.promise.then(
        (result) => settle(() => resolve(result)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /** One caller stopped waiting. Cancel the shared request when it was the last and the request can be cancelled. */
  #leave(key: string, entry: Entry): void {
    entry.waiting -= 1;
    if (entry.waiting > 0 || !entry.cancel) return;
    entry.abandoned = true;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    this.#cancelIfAbandoned(entry.cancel);
  }

  /** The live controller for requests started under `signal`, or a new one once the last has aborted. */
  #cancelFor(signal: AbortSignal): Cancel {
    const existing = this.#cancels.get(signal);
    if (existing && !existing.controller.signal.aborted) return existing;
    const cancel: Cancel = { controller: new AbortController(), live: new Set() };
    this.#cancels.set(signal, cancel);
    return cancel;
  }

  /** Abort once no request on `cancel` has a caller left. A request still awaited keeps its siblings running. */
  #cancelIfAbandoned(cancel: Cancel): void {
    if (cancel.live.size === 0) return;
    for (const entry of cancel.live) if (!entry.abandoned) return;
    cancel.controller.abort();
  }
}

const ignore = (): void => undefined;

/** The caller's own abort reason, matching what an uncoalesced call rejects with. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
