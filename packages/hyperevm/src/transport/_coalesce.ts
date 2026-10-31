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
  controller: AbortController | undefined;
  /** Callers still waiting on it. */
  waiting: number;
  /** Wall-clock time after which no caller joins, and joined callers stop waiting. */
  deadline: number;
}

type Run = (signal: AbortSignal | undefined) => Promise<unknown>;

/** One instance's table of shared in-flight reads. */
export class Coalescer {
  readonly #entries = new Map<string, Entry>();
  readonly #maxWaitMs: number;

  /**
   * `maxWaitMs` bounds how long a joined caller waits on another caller's request. On Workers the invocation that
   * started it can end and take its I/O and timers with it, so the shared promise may never settle. A caller past
   * the bound starts a fresh request, and the stuck one is never joined again.
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
   * key then stays the shared default. `onJoin` fires for a caller that joined an existing request.
   * A caller whose signal has already aborted neither joins nor starts one: `run` gets its signal, as uncoalesced.
   */
  request(key: string, signal: AbortSignal | undefined, run: Run, onJoin: () => void): Promise<unknown> {
    if (signal?.aborted) return run(signal);
    const existing = this.#entries.get(key);
    if (existing && Date.now() < existing.deadline) {
      onJoin();
      return this.#wait(key, existing, signal, () => this.request(key, signal, run, ignore));
    }
    return this.#wait(key, this.#start(key, signal !== undefined, run), signal, undefined);
  }

  #start(key: string, cancellable: boolean, run: Run): Entry {
    const controller = cancellable ? new AbortController() : undefined;
    let started: Promise<unknown>;
    try {
      started = run(controller?.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    const entry: Entry = { promise: started, controller, waiting: 0, deadline: Date.now() + this.#maxWaitMs };
    entry.promise = started.finally(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
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
      if (retry) {
        timer = setTimeout(
          () =>
            settle(() => {
              if (this.#entries.get(key) === entry) this.#entries.delete(key);
              this.#leave(key, entry);
              retry().then(resolve, reject);
            }),
          Math.max(0, entry.deadline - Date.now()),
        );
        // The shared request carries the work. This timer only bounds the wait on it.
        unrefTimer(timer);
      }
      entry.promise.then(
        (result) => settle(() => resolve(result)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /** One caller stopped waiting. Cancel the shared request when it was the last and the request can be cancelled. */
  #leave(key: string, entry: Entry): void {
    entry.waiting -= 1;
    if (entry.waiting > 0 || !entry.controller) return;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    entry.controller.abort();
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
