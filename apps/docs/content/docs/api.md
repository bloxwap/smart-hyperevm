---

title: API and safety
description: Inspect HyperEVM transport telemetry, errors, cache statistics, and transaction safety.
---

# API and safety

## Events

Pass `onEvent` when creating the transport:

```ts
const transport = smartHyperevm({
  onEvent(event) {
    if (event.type === "failover") {
      console.log(event.from, "->", event.to);
    }
  },
});
```

Events cover requests, successes, errors, failovers, hedges, races, coalescing, cache hits and refreshes, heads, quarantine, breaker transitions, and persistence failures. Telemetry listener errors do not fail requests.

## Routing state

```ts
const snapshot = transport.value.snapshot("eth_call");
const cache = transport.value.cacheStats();
```

`snapshot(method)` reports endpoint scores, heads, lag, quarantine, in-flight counts, and remaining budget tokens. `cacheStats()` reports hits, misses, refreshes, entries, bytes, and hot keys.

Endpoint scores can be saved and restored explicitly:

```ts
const scores = transport.value.scores();
transport.value.restoreScores(scores);
```

Heads, ejections, and chain checks are never restored.

## Errors

Transport-specific errors include `AllEndpointsFailedError`, `BudgetExhaustedError`, `ChainMismatchError`, and `TransportClosedError`. Endpoint errors carry redacted labels rather than keyed URLs.

Execution reverts, invalid parameters, transaction rejections, user rejections, and caller aborts are terminal answers rather than endpoint failures. Timeouts, connection failures, rate limits, unavailable blocks, and provider range limits may fail over.

## Transaction safety

Sends, signing methods, subscriptions, and filter operations are never raced or hedged. Signed raw transactions fail over on endpoint errors because rebroadcasting the same bytes cannot create a second execution.

```ts
const transport = smartHyperevm({
  rebroadcastRawTransactions: false,
});
```

Use this option to send only once. An `"already known"` response to a rebroadcast returns the transaction hash; `"nonce too low"` is thrown.

## Credential safety

Load private RPC URLs from the environment or a secret store. Never commit API keys, usernames, passwords, or private keys. Events, snapshots, endpoint lists, and errors use labels or credential-free origins.

This package routes JSON-RPC. It does not sign transactions or hold a wallet.
