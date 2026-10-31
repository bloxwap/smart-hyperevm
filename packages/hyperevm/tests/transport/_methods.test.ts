import { describe, expect, test } from "bun:test";

import {
  isAlreadyKnownError,
  isBlockNotHeldError,
  isIdempotentMethod,
  isRebroadcastMethod,
  shouldFailover,
  toError,
} from "../../src/transport/_methods.ts";

describe("method safety", () => {
  test("transaction sends and subscriptions are not idempotent", () => {
    expect(isIdempotentMethod("eth_call")).toBe(true);
    expect(isIdempotentMethod("eth_getLogs")).toBe(true);
    expect(isIdempotentMethod("eth_blockNumber")).toBe(true);
    expect(isIdempotentMethod("eth_sendRawTransaction")).toBe(false);
    expect(isIdempotentMethod("eth_sendTransaction")).toBe(false);
    expect(isIdempotentMethod("eth_subscribe")).toBe(false);
    expect(isIdempotentMethod("eth_getFilterChanges")).toBe(false);
    expect(isIdempotentMethod("eth_newFilter")).toBe(false);
    expect(isIdempotentMethod("eth_newBlockFilter")).toBe(false);
    expect(isIdempotentMethod("eth_newPendingTransactionFilter")).toBe(false);
    expect(isIdempotentMethod("eth_getFilterLogs")).toBe(true);
    expect(isIdempotentMethod("eth_call", ["eth_call"])).toBe(false);
  });

  test("reverts and invalid params do not fail over, transport failures do", () => {
    expect(shouldFailover(Object.assign(new Error("execution reverted: boom"), { code: 3 }))).toBe(false);
    expect(shouldFailover(Object.assign(new Error("invalid"), { code: -32602 }))).toBe(false);
    expect(shouldFailover(Object.assign(new Error("rejected"), { code: 4001 }))).toBe(false);
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(shouldFailover(aborted)).toBe(false);
    expect(shouldFailover(Object.assign(new Error("limit"), { code: -32005 }))).toBe(true);
    expect(shouldFailover(Object.assign(new Error("missing method"), { code: -32601 }))).toBe(true);
    expect(shouldFailover(new Error("socket hang up"))).toBe(true);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(shouldFailover(timeout)).toBe(true);
  });

  test("provider limits coded -32602 fail over, genuine invalid params do not", () => {
    const limits = [
      "query exceeds max block range 1000",
      "block range is too wide",
      "Block range limit exceeded.",
      "exceed maximum block range: 50",
      "ranges over 10000 blocks are not supported on freetier",
      "query returned more than 10000 results",
      "too many logs in response",
      "Log response size exceeded.",
      "eth_getLogs is limited to a 10,000 range",
      "query timeout exceeded",
    ];
    for (const message of limits)
      expect(shouldFailover(Object.assign(new Error(message), { code: -32602 }))).toBe(true);
    const invalid = ["invalid argument 0: hex string without 0x prefix", "missing value for required argument 0"];
    for (const message of invalid)
      expect(shouldFailover(Object.assign(new Error(message), { code: -32602 }))).toBe(false);
    // A revert stays terminal even when its reason mentions a limit.
    expect(shouldFailover(Object.assign(new Error("execution reverted: limit exceeded"), { code: -32602 }))).toBe(
      false,
    );
  });

  test("a block the endpoint has not reached fails over, and is not an endpoint failure", () => {
    const notHeld: [string, number][] = [
      // The official HyperEVM RPC, for eth_getLogs past its head.
      ["invalid block range", -32602],
      ["invalid block range params", -32602],
      ["header not found", -32000],
      ["unknown block", -32000],
      ["block range extends beyond current head block", -32000],
    ];
    for (const [message, code] of notHeld) {
      const error = Object.assign(new Error(message), { code });
      expect([message, shouldFailover(error), isBlockNotHeldError(error)]).toEqual([message, true, true]);
    }
    // viem keeps the node's message in `details`.
    const wrapped = Object.assign(new Error("Invalid parameters were provided to the RPC method."), {
      code: -32602,
      details: "invalid block range",
    });
    expect(isBlockNotHeldError(wrapped)).toBe(true);
    for (const message of [
      "socket hang up",
      "execution reverted",
      "invalid argument 0: hex string without 0x prefix",
    ]) {
      expect(isBlockNotHeldError(new Error(message))).toBe(false);
    }
  });

  test("node verdicts on a transaction are terminal", () => {
    for (const message of ["nonce too low", "insufficient funds for gas * price + value", "already known"]) {
      expect(shouldFailover(Object.assign(new Error(message), { code: -32000 }))).toBe(false);
    }
    expect(isAlreadyKnownError(new Error("already known"))).toBe(true);
    expect(isAlreadyKnownError(new Error("known transaction: 0xabc"))).toBe(true);
    expect(isAlreadyKnownError(new Error("unknown transaction type"))).toBe(false);
    expect(shouldFailover(new Error("unknown transaction type"))).toBe(true);
  });

  test("only signed raw sends may be rebroadcast", () => {
    expect(isRebroadcastMethod("eth_sendRawTransaction")).toBe(true);
    expect(isRebroadcastMethod("eth_sendRawTransactionSync")).toBe(true);
    expect(isRebroadcastMethod("eth_sendTransaction")).toBe(false);
    expect(isRebroadcastMethod("eth_subscribe")).toBe(false);
  });

  test("normalizes unknown thrown values", () => {
    const error = new Error("boom");
    expect(toError(error)).toBe(error);
    expect(toError("boom").message).toBe("boom");
    expect(toError({ reason: "boom" }).message).toBe("Unknown endpoint error");
  });
});
