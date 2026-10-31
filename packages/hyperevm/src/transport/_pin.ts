/**
 * Pin `"latest"` to a block every endpoint that may serve the call holds.
 *
 * Endpoints a block or two apart answer `"latest"` for different blocks, so an `eth_blockNumber` from one node
 * and an `eth_getLogs` from the next can disagree, and a failover can answer for an older block than the first
 * attempt saw. Rewriting the tag to the lowest fresh head among the servable endpoints makes every attempt,
 * failover, and hedge answer for the same block. `eth_blockNumber` is then answered with that block, so the
 * number a client reads is one the next read can be served at.
 * @module
 */

import { parseQuantity } from "./_scoreboard.ts";

/** Heads older than this do not pin. HyperEVM makes about one block per second. */
export const DEFAULT_PIN_FRESH_MS = 1_000;

/** Options for `pinLatest`. */
export interface PinLatestOptions {
  /** Heads older than this many milliseconds do not pin. Default: 1000. */
  freshMs?: number | undefined;
  /**
   * Answer `eth_blockNumber` locally with the block a pinned `"latest"` would use, when one exists.
   * Answers never go backwards, upstream ones included. Default: true.
   */
  blockNumber?: boolean | undefined;
}

/** Resolved `pinLatest` settings. */
export interface PinConfig {
  enabled: boolean;
  freshMs: number;
  blockNumber: boolean;
}

/** One endpoint's head, as the scoreboard reports it. */
export interface HeadReading {
  readonly id: string;
  readonly head: number;
  /** False when no reference head is believed or this head is ignored as implausible. */
  readonly trusted: boolean;
}

/** What the pin reads from the transport. */
export interface PinSource {
  /** Heads seen in the last `maxAgeMs`. */
  heads: (maxAgeMs: number) => readonly HeadReading[];
  /** Blocks behind the highest servable head that still pin. */
  maxLag: number;
  /** True when `id` may serve `method` now: chain verified, not quarantined, not ejected, method supported. */
  servable: (id: string, method: string) => boolean;
}

export function resolvePin(value: boolean | PinLatestOptions | undefined): PinConfig {
  const options = typeof value === "object" ? value : {};
  return {
    enabled: value !== undefined && value !== false,
    freshMs: options.freshMs ?? DEFAULT_PIN_FRESH_MS,
    blockNumber: options.blockNumber ?? true,
  };
}

/** Where a method carries its block tag, and whether an omitted tag means `"latest"`. */
const BLOCK_SLOTS: ReadonlyMap<string, { index: number; implied: boolean }> = new Map([
  ["eth_call", { index: 1, implied: true }],
  ["eth_getBalance", { index: 1, implied: true }],
  ["eth_getCode", { index: 1, implied: true }],
  ["eth_getTransactionCount", { index: 1, implied: true }],
  ["eth_getStorageAt", { index: 2, implied: true }],
  // Some nodes estimate against "pending" when the tag is omitted, so only an explicit "latest" is pinned.
  ["eth_estimateGas", { index: 1, implied: false }],
  ["eth_getBlockByNumber", { index: 0, implied: false }],
  ["eth_feeHistory", { index: 1, implied: false }],
]);

function toHex(block: number): string {
  return `0x${block.toString(16)}`;
}

/**
 * `params` with every `"latest"`, given or implied, replaced by `block`. A copy, never the caller's object.
 * `"pending"`, `"safe"`, `"finalized"`, `"earliest"`, numbers, and `{ blockHash }` references are left alone.
 * Returns `params` itself when nothing changes.
 */
export function pinParams(method: string, params: unknown, block: number): unknown {
  if (!Array.isArray(params)) return params;
  if (method === "eth_getLogs") return pinLogs(params, block);
  const slot = BLOCK_SLOTS.get(method);
  // A call missing an earlier param cannot carry the tag. The endpoint rejects it as sent.
  if (!slot || params.length < slot.index) return params;
  const tag: unknown = params[slot.index];
  const pinned = tag === undefined ? (slot.implied ? toHex(block) : undefined) : pinTag(tag, block);
  if (pinned === undefined) return params;
  const next = [...params];
  next[slot.index] = pinned;
  return next;
}

/** The pinned form of one tag, or undefined when it is not `"latest"`. */
function pinTag(tag: unknown, block: number): unknown {
  if (tag === "latest") return toHex(block);
  // EIP-1898: `{ blockNumber: "latest" }` names the head. A `blockHash` names one block already.
  if (typeof tag !== "object" || tag === null || Array.isArray(tag)) return undefined;
  if ("blockHash" in tag || !("blockNumber" in tag) || tag.blockNumber !== "latest") return undefined;
  return { ...tag, blockNumber: toHex(block) };
}

/** An omitted `fromBlock` or `toBlock` means `"latest"`. A `blockHash` filter is never touched. */
function pinLogs(params: readonly unknown[], block: number): unknown {
  const filter: unknown = params[0];
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return params;
  if ("blockHash" in filter && filter.blockHash !== undefined && filter.blockHash !== null) return params;
  const fields = filter as { fromBlock?: unknown; toBlock?: unknown };
  const from = fields.fromBlock ?? "latest";
  const to = fields.toBlock ?? "latest";
  const pinFrom = from === "latest";
  const pinTo = to === "latest";
  if (!pinFrom && !pinTo) return params;
  // A range that starts above the pin, or ends below it, keeps its tags: pinning must not invert it.
  const fromBlock = pinFrom ? block : parseQuantity(from);
  const toBlock = pinTo ? block : parseQuantity(to);
  if (fromBlock !== null && toBlock !== null && fromBlock > toBlock) return params;
  return [
    { ...filter, fromBlock: pinFrom ? toHex(block) : from, toBlock: pinTo ? toHex(block) : to },
    ...params.slice(1),
  ];
}

/** Per-instance pinning. Holds one number: the highest `eth_blockNumber` it has returned. */
export class LatestPin {
  readonly #config: PinConfig;
  readonly #source: PinSource;
  #served = -1;

  constructor(config: PinConfig, source: PinSource) {
    this.#config = config;
    this.#source = source;
  }

  /** True when `eth_blockNumber` goes through {@link LatestPin.blockNumber} and {@link LatestPin.observe}. */
  get answersBlockNumber(): boolean {
    return this.#config.enabled && this.#config.blockNumber;
  }

  /**
   * The lowest fresh, trusted head among endpoints that may serve `method`, or null when none qualifies.
   * Heads more than `maxLag` behind the highest of them are left out: that endpoint is scored down already,
   * and waiting on it would pin state several blocks old.
   */
  floor(method: string): number | null {
    let top: number | null = null;
    const usable: number[] = [];
    for (const reading of this.#source.heads(this.#config.freshMs)) {
      if (!reading.trusted || !this.#source.servable(reading.id, method)) continue;
      usable.push(reading.head);
      if (top === null || reading.head > top) top = reading.head;
    }
    if (top === null) return null;
    const cutoff = top - this.#source.maxLag;
    let floor = top;
    for (const head of usable) if (head >= cutoff && head < floor) floor = head;
    return floor;
  }

  /** `params` with `"latest"` pinned, for an idempotent read while a floor exists. Otherwise `params` itself. */
  params(method: string, params: unknown, idempotent: boolean): unknown {
    if (!this.#config.enabled || !idempotent) return params;
    if (method !== "eth_getLogs" && !BLOCK_SLOTS.has(method)) return params;
    const block = this.floor(method);
    return block === null ? params : pinParams(method, params, block);
  }

  /** The local `eth_blockNumber` answer, or undefined when it must go upstream. */
  blockNumber(): string | undefined {
    if (!this.answersBlockNumber) return undefined;
    const block = this.floor("eth_blockNumber");
    return block === null ? undefined : toHex(this.#serve(block));
  }

  /** An upstream `eth_blockNumber` answer, raised to the highest one already returned. */
  observe(result: unknown): unknown {
    const block = parseQuantity(result);
    if (block === null) return result;
    const served = this.#serve(block);
    return served === block ? result : toHex(served);
  }

  #serve(block: number): number {
    if (block > this.#served) this.#served = block;
    return this.#served;
  }
}
