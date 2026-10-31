/**
 * JSON-RPC methods that must not be retried or hedged, and error classification.
 *
 * A lost response is not proof the server never saw the call, so these methods
 * go to one endpoint. `eth_subscribe` is pinned to the socket that accepted it.
 * `eth_getFilterChanges` consumes what it returns, so a re-sent poll can answer
 * `[]` for changes the lost response carried. Creating a filter makes state on
 * the node, so a re-sent `eth_new*Filter` would leave a duplicate behind.
 * The exception is a signed raw transaction: sending the same bytes again has
 * the same hash, and the nonce stops it from running twice. Those two methods
 * fail over on endpoint errors (see {@link REBROADCAST_METHODS}) but are never
 * hedged.
 * @module
 */

/** Methods the transport sends to at most one endpoint. */
export const NON_IDEMPOTENT_METHODS: readonly string[] = [
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "personal_sign",
  "personal_sendTransaction",
  "eth_submitWork",
  "eth_submitHashrate",
  "wallet_sendTransaction",
  "wallet_sendCalls",
  "eth_subscribe",
  "eth_getFilterChanges",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
];

const DEFAULT_NON_IDEMPOTENT: ReadonlySet<string> = new Set(NON_IDEMPOTENT_METHODS);

/** Signed raw transaction sends. Rebroadcasting the same bytes is safe, so they fail over. */
export const REBROADCAST_METHODS: readonly string[] = ["eth_sendRawTransaction", "eth_sendRawTransactionSync"];

const DEFAULT_REBROADCAST: ReadonlySet<string> = new Set(REBROADCAST_METHODS);

/** Codes and messages that describe the call, not a sick endpoint. */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  3, // execution reverted
  -32700, // parse error
  -32600, // invalid request
  -32602, // invalid params
  -32003, // transaction rejected
  4001, // user rejected
  5000, // CAIP-25 user rejected
]);

const TERMINAL_MESSAGE = /execution reverted|gas required exceeds allowance/i;

/** Node-side verdicts on a signed transaction. Every endpoint would say the same. */
const REJECTED_TRANSACTION_MESSAGE =
  /nonce too (?:low|high)|insufficient funds|intrinsic gas too low|transaction underpriced|exceeds block gas limit|max fee per gas less than block base fee|invalid sender|already known|\bknown transaction|already imported|already in (?:the )?(?:mem)?pool/i;

/** A node already holds this transaction. On a rebroadcast, an earlier attempt landed. */
const ALREADY_KNOWN_MESSAGE = /already known|\bknown transaction|already imported|already in (?:the )?(?:mem)?pool/i;

/**
 * Provider limits that some nodes report as invalid params (`-32602`).
 * Another endpoint may have a larger limit, so these fail over.
 */
const PROVIDER_LIMIT_MESSAGE =
  /(?:max(?:imum)?|exceed\w*|too (?:large|wide|big|many)|limit\w*)[^.\n]*block range|block range[^.\n]*(?:too|exceed\w*|limit\w*|max)|ranges? over \d|too many (?:results|logs|blocks)|more than \d[\d,]* (?:results|logs|blocks)|response size|size (?:limit|exceeded)|limit exceeded|limited to|query timeout|query timed out/i;

/**
 * A node that has not reached the block a call names. Nodes a block or two apart disagree on what exists, so
 * another endpoint may hold it. The official HyperEVM RPC answers `eth_getLogs` past its head with `-32602 invalid
 * block range`, and geth answers a state read past it with `header not found`. An inverted range gets the same
 * text: failing it over costs a few requests, and every endpoint then rejects it alike.
 */
const BLOCK_NOT_HELD_MESSAGE =
  /header not found|unknown block|invalid block range|block range extends beyond|beyond (?:the )?(?:current )?head/i;

/** JSON-RPC invalid params. */
const INVALID_PARAMS_CODE = -32602;

/** True when the method is safe to send again to a different endpoint. */
export function isIdempotentMethod(method: string, extra: readonly string[] = []): boolean {
  if (DEFAULT_NON_IDEMPOTENT.has(method)) return false;
  return !extra.includes(method);
}

function errorText(error: Error): string {
  const details = "details" in error && typeof error.details === "string" ? error.details : "";
  return `${error.message}\n${details}`;
}

function errorCode(error: Error): number | undefined {
  if ("code" in error && typeof error.code === "number") return error.code;
  return undefined;
}

/** True when the method is a signed raw transaction send that may be rebroadcast. */
export function isRebroadcastMethod(method: string): boolean {
  return DEFAULT_REBROADCAST.has(method);
}

/** True when a node reports that it already has the transaction. */
export function isAlreadyKnownError(error: Error): boolean {
  return ALREADY_KNOWN_MESSAGE.test(errorText(error));
}

/**
 * True when the endpoint answered that it does not hold the block the call names yet. Another endpoint may, so the
 * call fails over, but the endpoint is not sick: it is a block behind. It costs no breaker strike or error sample.
 */
export function isBlockNotHeldError(error: Error): boolean {
  return !isAbortError(error) && BLOCK_NOT_HELD_MESSAGE.test(errorText(error));
}

/** True when the failure is an abort initiated by the caller or by hedge cancellation. */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

/**
 * True when another endpoint might answer this call.
 * Execution reverts, invalid params, transaction rejections, and user
 * rejections stay on the caller: the endpoint answered. Provider limits coded
 * as invalid params (block range, result count, response size) fail over, and
 * so does a block the endpoint has not reached yet.
 */
export function shouldFailover(error: Error): boolean {
  if (isAbortError(error)) return false;
  const text = errorText(error);
  if (TERMINAL_MESSAGE.test(text)) return false;
  if (REJECTED_TRANSACTION_MESSAGE.test(text)) return false;
  if (BLOCK_NOT_HELD_MESSAGE.test(text)) return true;
  const code = errorCode(error);
  if (code === INVALID_PARAMS_CODE && PROVIDER_LIMIT_MESSAGE.test(text)) return true;
  if (code !== undefined && TERMINAL_CODES.has(code)) return false;
  return true;
}

/** Normalize unknown throw values into Error instances. */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Unknown endpoint error");
}
