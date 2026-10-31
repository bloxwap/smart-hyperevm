# Ranking

`@bloxwap/hyperevm` has two rankers. They answer different questions.

The **transport** ranks endpoints from the calls your process is making right now. The **registry ranker** (`bun run rank`) decides which public URLs are worth putting in that pool, and at what weight, from a rolling window of probes. A fast sample on a brand-new URL cannot take the pool over.

## Runtime score

For each endpoint the transport keeps a latency EWMA, a tail EWMA, an error EWMA, and the number of calls currently in flight. A call stops counting as in flight one second after its timeout even if its own cleanup never ran, as when Workers cancels the invocation that started it, so a shared instance cannot keep routing away from that endpoint. Per-method books (`eth_call`, `eth_getLogs`, and so on) are separate. Until a method has a few samples, its score blends back toward the endpoint's global book.

Service time is

```
service = mix * ewma + (1 - mix) * tail
```

with `mix` defaulting to 0.6 (`latencyMix`). The tail EWMA uses a larger step when the new sample is slower than the tail (`tailAlphaUp` 0.5), and a small step when it is faster (`tailAlphaDown` 0.05). The mean uses `ewmaAlphaUp` 0.4 and `ewmaAlphaDown` 0.2. Failures move an error EWMA with `errorAlpha` 0.3. A single slow response moves the tail immediately. A run of fast responses does not wipe it out. That is the C3 idea used here: rank on the slow tail, not only the mean. The cubic queue function from the C3 paper is not used raw. A burst of parallel `eth_call`s would otherwise exile a healthy public node. The in-flight term is Prequal's "your call waits behind the ones already running", plus a damped square:

```
inflation = 1 + inflight + 0.25 * inflight^2
score     = service * inflation * (1 + 8 * error) * lagPenalty / weight
```

Lower score is better. `weight` comes from the registry. An explicit endpoint you pass yourself defaults to weight 1 when the registry has no positive weight for it.

`lagPenalty` is 1 when head-lag checks are off, when this endpoint's head is unknown, or when it is within `maxLag` blocks (default 2) of the reference head. Past that, the penalty is `1 + lagWeight * (lag - maxLag)`, and `lagWeight` defaults to 1.

Heads come from `eth_blockNumber` results and from `eth_getBlockByNumber("latest")`. A block fetched by hash, by number, or by another tag is history and does not move the head. A head older than `staleMs` (default 30 seconds) stops counting.

The reference head is the highest fresh head that the other endpoints corroborate. Each fresh head is compared with the median of the other fresh heads, carried forward at 2 blocks per second to the same instant. A head that leads that median by more than `maxAhead` (default 1000) blocks is ignored. Its endpoint is scored as if it lagged by as much as it leads, and its `head` event has `trusted: false`. With three or more fresh heads the majority decides. Endpoints in front of the same backend agree with each other, so two keyed URLs for one stuck provider can outvote an honest third. Count them as one when sizing the pool. With exactly two that far apart, either could be broken, so no reference is believed and lag stops counting until a third head arrives. A liar within `maxAhead` can still raise the reference. The check catches broken heads, not adversarial nodes, which could lie about state anyway.

The first attempt uses power of two choices: draw two endpoints that support the method, send to the one with the better score. Failover, and hedging, then take the best remaining endpoint. Ties break toward the earlier endpoint.

Head probes call `eth_blockNumber` on an interval (default 4 seconds). A successful probe updates the head and cools the error rate. It does not write the latency EWMA, so the timer is not a second copy of viem's `rank` ping. A failed probe does push the tail, because a node that stops answering should lose traffic before the next user call hangs. The timer is unref'd on Node and Bun so it does not keep a short-lived process alive. A viem transport whose `methods` filter rejects `eth_blockNumber` is not probed.

The timer starts on the first request, not when the transport is built, and stops after `probeIdleTimeout` (default 60 seconds) without a request. The next request starts it again. Probes do not count as activity. One `hyperevm()` factory shares one instance, with one scoreboard and one timer, across every client built with the same timeout, retry count, and chain id, so per-request clients do not multiply probes or reset scores. `value.close()` stops the timer and rejects later requests with `TransportClosedError`. Calls already in flight finish.

## Chain id

Unless `verifyChainId` is false, each endpoint answers one `eth_chainId` before its first call or probe. The expected id is the client chain, or 999. The check does not write a latency sample. A wrong id quarantines the endpoint for the life of the instance: no call, hedge, or probe goes to it, a `quarantine` event fires, and its snapshot shows `quarantined: true`. If every endpoint is quarantined the call throws `ChainMismatchError`, or `AllEndpointsFailedError` holding one per endpoint when there are several. A network error or rate limit on the check does not quarantine. It counts toward the breaker like any endpoint failure, the call moves to another endpoint without spending an attempt, and the check runs again on the next call. Concurrent calls share one check, and each waits under its own `timeout`. On Workers, the request that started a check can end and take the check with it, so a call that times out waiting drops the check and the next call starts a new one. A call that waited on a check picks again once it passes, so a burst of cold calls spreads over the endpoints instead of piling onto the first one checked. A viem transport whose `methods` filter rejects `eth_chainId` is not checked, since viem would refuse the call locally. A call its filter refuses never counts against the endpoint.

## Circuit breaker

Three consecutive endpoint failures eject an endpoint for 5 seconds. Each later ejection doubles that, up to 60 seconds. A `Retry-After` header (seconds or an HTTP date) ejects it at once for the time asked, capped at 60 seconds. For URL endpoints this includes a 429 or 503 whose body is a JSON-RPC error, where viem drops the headers. A viem transport you pass in keeps only what viem's error carries. Any healthy answer to a call, including a revert or another terminal error, closes the circuit and fires `restore`. A head probe or chain check does not end an ejection early, and does not clear a failure streak that holds a failed call: a node can answer `eth_blockNumber` while every `eth_call` hangs. Its success clears only a streak of probe and check failures.

Routing skips ejected endpoints while any other candidate is left. When every endpoint is ejected before a call starts, its first attempt still goes to the best one, so a call always has somewhere to go. Otherwise nothing is sent to an endpoint that is ejected at the moment of sending: a call does not fail over into one or send it a chain check, and hedges never target one. If only ejected endpoints are left, the call starts another round on the endpoints that already failed it instead. After every wait (a chain check, `retryDelay`, a backoff) the call picks again against the breaker as it is then, so a cooldown another call opened during the wait is respected. A call waits out ejections for at most 2 seconds in total, and otherwise stops with its last error. Probes skip ejected endpoints until the cooldown ends, so a provider that asked for 30 seconds gets them. With three endpoints all returning 429, ten calls cost 16 upstream requests instead of 30, or 17 counting the chain checks. Set `breaker: false` to turn it off, or pass `{ threshold, cooldown, maxCooldown }`.

## What is not retried

These methods go to one endpoint and are never hedged:

`eth_sendTransaction`, `eth_sign`, `eth_signTransaction`, `eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`, `personal_sign`, `personal_sendTransaction`, `eth_submitWork`, `eth_submitHashrate`, `wallet_sendTransaction`, `wallet_sendCalls`, `eth_subscribe`, `eth_getFilterChanges`, `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`.

`eth_getFilterChanges` returns what changed since the previous poll and consumes it, so re-sending a poll whose response was lost would answer `[]` and drop those changes.

Pass more names in `nonIdempotentMethods`.

`eth_sendRawTransaction` and `eth_sendRawTransactionSync` are never hedged either, but they fail over on endpoint errors. Sending the same signed bytes again has the same hash, and the nonce stops a second execution. On a re-send, an "already known" answer means an earlier attempt landed, so `eth_sendRawTransaction` returns `keccak256` of the bytes. The Sync variant throws instead, since no receipt can be built from that answer. "nonce too low" on a re-send is thrown: the earlier attempt may have landed, and the transport does not look it up. Set `rebroadcastRawTransactions: false` to send them once.

Failover stops on execution reverts, invalid params, invalid requests, parse errors, transaction rejections (nonce, funds, gas, fee, sender, already known), user rejections, and caller aborts. These are the endpoint answering about the call, so they count as a healthy answer, not an endpoint error. Some providers report `eth_getLogs` range and result limits as invalid params (`-32602`). When the message describes a block range, result count, response size, or query timeout limit, the call fails over, since another endpoint may allow more. A timeout, a reset connection, a rate limit, an internal error, or "method not found" tries the next endpoint, up to `retryCount` extra attempts (default 2).

Each endpoint is tried once before any is tried again. Once every eligible endpoint has failed a call and attempts remain, the call waits a jittered exponential backoff and starts another round. The base is `retryDelay`, or 100ms when it is 0. Each wait is half to all of `base * 2^round`, capped at 2 seconds, and at least the ejection left on the endpoint it will try. A call stops rather than wait out a longer ejection. With the default `retryCount`, a single endpoint survives one 429.

Hedging is off unless you set `hedge`. When it is on, an idempotent read that is still running after `max(minDelay, multiplier * tail)` is copied to the next endpoint. The first success wins. Cancelling the loser does not count as an error. Hedges never go to an ejected endpoint. A backup that has not passed its chain check is checked first, then hedged if the read is still running, so hedging works with probes off.

## Registry score

`packages/hyperevm/.dev/rank.ts` fetches the source lists, merges them with `packages/hyperevm/registry/nodes.json`, probes every HTTP URL, appends the observations to `packages/hyperevm/registry/history.json`, and writes ranks back. The workflow `.github/workflows/rank-registry.yml` runs that weekly and on demand, then opens a pull request. It does not push to `main`.

A probe is `eth_chainId`, `eth_blockNumber`, `eth_call` to the zero address, `eth_getLogs` for a single block filtered to an address that should have no logs, a HyperCore read precompile call, and `eth_getLogs` over a realistic range. The chain id must be 999. A higher head from a node on the wrong chain is ignored.

The precompile call is `eth_call` to `l1BlockNumber` at `0x0000000000000000000000000000000000000809` with empty calldata. It passes when the reply is a 32-byte word that is not zero. The range call covers the 999 blocks ending at the probed head, with the same empty-log address, so it tests whether a provider accepts the range, not whether it can scan a busy contract. A probe counts as a success only when both pass. If the latest probe from a live node failed the precompile call, the endpoint is ineligible (weight 0) until a later probe passes. Older history rows without these results count as passes. `stats.precompileOk` holds the latest verdict, or null.

`lag` is how many blocks behind the best head in that probe run the node was. Heads are not sampled at the same instant, and HyperEVM produces a block about once a second, so each head is projected forward to the latest sample in the run before the gap is measured. The registry score then ignores the first 2 blocks of lag, the same grace the transport uses. Past that, the penalty is `1 + (lag - 2)`.

Inside the window (28 days):

- **Uptime** is successes over observations. Below 0.5 the endpoint stays listed at weight 0.
- **Latency** is the worst per-method median, not the best. A node that is quick at `eth_chainId` and slow at `eth_getLogs` is scored on `eth_getLogs`. **Tail** is the slowest successful sample in the window.
- **Lag** uses the adjustment above. A node one or two blocks behind scores the same as a node at the tip. A node many blocks behind does not.
- **Established** means at least 3 successes, uptime at least 0.8, and the first and last observation in the window at least 14 days apart. Established endpoints get weight 1.
- Everyone else with a success and uptime at least 0.5 gets the **new-node cap**, weight 0.15. Three probes fired the same day do not establish a node. The weekly schedule cannot be gamed by re-running the workflow.
- Once any endpoint is established, the non-established endpoints together are scaled down until they are at most 25% of the total weight. If nobody is established yet, the cap is not applied on top of itself, so a fresh registry still spreads traffic.

WebSocket URLs are stored and are not part of the default HTTP pool. The transport will use a `wss://` URL when you pass it yourself.

Community submissions (see [CONTRIBUTING.md](../CONTRIBUTING.md)) stay in the file when upstream lists stop mentioning them. An upstream URL that disappears from every source is removed on the next successful run.

If a source list fails to download, the script exits and does not write. If a registry that already had eligible endpoints gets a run where nobody returns chain id 999, or a ranking that leaves no endpoint eligible (for example when every HyperCore read probe fails at once), the script also refuses to write. One bad network day must not empty the pool.

## Sources

The ranker reads only these documents:

| Source | What it contributes |
| --- | --- |
| [chainlist `chainid-999.js`](https://github.com/DefiLlama/chainlist/blob/main/constants/additionalChainRegistry/chainid-999.js) | HyperEVM's `rpc` array. The file's name and `"chainId": 999` are both required, so a different chain cannot be parsed by accident. |
| [chainlist `extraRpcs.js`](https://github.com/DefiLlama/chainlist/blob/main/constants/extraRpcs.js) | The `999` object only. Chainlist's chain id table labels 999 as Hyperliquid. |
| [ChainIndex](https://www.chainindex.dev/chains/hyperevm) | RPC-shaped links on the HyperEVM page. |
| [OpenChainBench](https://openchainbench.com/benchmarks/hyperliquid-rpc) | RPC-shaped links on the Hyperliquid public-endpoint benchmark. |
| [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) | The documented mainnet URL. Testnet URLs in the same page are dropped. |

URLs with a query string, a username, or a hash are rejected. `http://` is rejected. Anything whose URL contains `testnet` is rejected.

**ethereum-lists `eip155-999.json` is not a source.** That file is Wanchain Testnet, which reused chain id 999. The parser and the registry check both refuse a hostname of `wandevs.org` or a subdomain of it.

## Gaps

- There is no merged `value.subscribe`. A subscription stays on the socket that accepted `eth_subscribe`. viem's `fallback` has the same gap. HTTP endpoints do not serve subscriptions.
- Hedge defaults off. A stall study is in [benchmarks.md](benchmarks.md). The cold hedge fires at `minDelay` (250ms), and several public nodes are slower than that, so those first calls would be duplicated.
- The shipped history starts with one probe run. Full weight waits for the window above, so every endpoint in the first ranked file is on the new-node cap. The shipped file predates the precompile and range probes, so it reflects them only after the next `bun run rank`. Production services should pass explicit endpoints.
- Snapshots do not show ejection state. Watch the `eject` and `restore` events.
- `close()` does not close a child `webSocket()` transport's socket or cancel calls in flight.
- Filters are not pinned to the node that made them. `eth_new*Filter` goes to one endpoint and is never retried, but a later `eth_getFilterChanges` may be routed elsewhere and answer "filter not found". Poll with `eth_getLogs` instead. viem's `fallback` has the same gap.
- One factory shares an instance per `timeout`, `retryCount`, and chain, and keeps it until `close()`. Clients built with a different timeout per request each get their own instance. Fix those options when the factory is created.
- Error redaction replaces exact spellings of a key-bearing URL. A provider that echoes the bare key elsewhere in an error is not scrubbed.
- The simulated comparison with viem `fallback` is in [benchmarks.md](benchmarks.md). A live run is a manual workflow, not part of CI.
