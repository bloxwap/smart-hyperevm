/**
 * Errors raised by the HyperEVM transport.
 *
 * Both extend viem's `BaseError`, so `buildRequest` rethrows them instead of
 * wrapping them in `UnknownRpcError`.
 * @module
 */

import { BaseError } from "viem";

/** Thrown when every attempted endpoint failed. The last error is `cause`. */
export class AllEndpointsFailedError extends BaseError {
  readonly errors: readonly Error[];

  constructor(errors: readonly Error[]) {
    const last = errors.at(-1);
    super("All HyperEVM endpoints failed.", {
      cause: last,
      details: last?.message ?? "no endpoints were attempted",
      name: "AllEndpointsFailedError",
    });
    this.name = "AllEndpointsFailedError";
    this.errors = errors;
  }
}

/** Thrown when one endpoint exceeds its deadline. Failover may try another endpoint. */
export class TimeoutError extends BaseError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("HyperEVM request timed out.", {
      details: `${timeoutMs}ms`,
      name: "TimeoutError",
    });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when an endpoint reports another chain id. The transport stops calling that endpoint. */
export class ChainMismatchError extends BaseError {
  readonly endpoint: string;
  readonly expected: number;
  readonly chainId: number;

  constructor(endpoint: string, expected: number, chainId: number) {
    super("HyperEVM endpoint is on the wrong chain.", {
      details: `${endpoint} reported chain id ${chainId}, expected ${expected}`,
      name: "ChainMismatchError",
    });
    this.name = "ChainMismatchError";
    this.endpoint = endpoint;
    this.expected = expected;
    this.chainId = chainId;
  }
}

/** Thrown by `request()` after `value.close()`. Instantiate the transport again to keep going. */
export class TransportClosedError extends BaseError {
  constructor() {
    super("HyperEVM transport is closed.", {
      details: "value.close() was called on this transport.",
      name: "TransportClosedError",
    });
    this.name = "TransportClosedError";
  }
}
