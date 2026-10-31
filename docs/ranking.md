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

## Inactive pages and apps

Probe ticks send nothing while `isActive()` returns false. Calls still run, on the scores and heads already learned, and a head goes stale after `staleMs` like any other. By default `isActive` is false only in a browser whose `document.visibilityState` is `"hidden"`. Workers, Node, Bun, and React Native have no such document, so they are always active. In a browser the transport adds one `visibilitychange` listener when the probe timer starts and removes it when the timer stops, on idle or `close()`. When the page becomes visible it runs a tick at once, so heads are fresh before the interval comes round. Switching tabs fires that event in bursts, so it probes only when no probe is in flight and none ran in the last `probeInterval`. The idle check runs while hidden too, so a hidden tab's timer and listener stop on schedule. A custom `isActive` replaces the visibility check. React Native can pass `() => AppState.currentState === "active"`, and ticks resume on the next interval after the app returns. A hook that throws counts as active. `value.probe()` runs whether or not the page is active.

## Chain id

Unless `verifyChainId` is false, each endpoint answers one `eth_chainId` before its first call or probe. The expected id is the client chain, or 999. The check does not write a latency sample. A wrong id quarantines the endpoint for the life of the instance: no call, hedge, or probe goes to it, a `quarantine` event fires, and its snapshot shows `quarantined: true`. If every endpoint is quarantined the call throws `ChainMismatchError`, or `AllEndpointsFailedError` holding one per endpoint when there are several. A network error or rate limit on the check does not quarantine. It counts toward the breaker like any endpoint failure, the call moves to another endpoint without spending an attempt, and the check runs again on the next call. Concurrent calls share one check, and each waits under its own `timeout`. On Workers, the request that started a check can end and take the check with it, so a call that times out waiting drops the check and the next call starts a new one. A call that waited on a check picks again once it passes, so a burst of cold calls spreads over the endpoints instead of piling onto the first one checked. A viem transport whose `methods` filter rejects `eth_chainId` is not checked, since viem would refuse the call locally. A call its filter refuses never counts against the endpoint.

## Circuit breaker

Three consecutive endpoint failures eject an endpoint for 5 seconds. Each later ejection doubles that, up to 60 seconds. A `Retry-After` header (seconds or an HTTP date) ejects it at once for the time asked, capped at 60 seconds. For URL endpoints this includes a 429 or 503 whose body is a JSON-RPC error, where viem drops the headers. A viem transport you pass in keeps only what viem's error carries. Any healthy answer to a call, including a revert or another terminal error, closes the circuit and fires `restore`. A head probe or chain check does not end an ejection early, and does not clear a failure streak that holds a failed call: a node can answer `eth_blockNumber` while every `eth_call` hangs. Its success clears only a streak of probe and check failures.

Routing skips ejected endpoints while any other candidate is left. When every endpoint is ejected before a call starts, its first attempt still goes to the best one, so a call always has somewhere to go. Otherwise nothing is sent to an endpoint that is ejected at the moment of sending: a call does not fail over into one or send it a chain check, and hedges never target one. If only ejected endpoints are left, the call starts another round on the endpoints that already failed it instead. After every wait (a chain check, `retryDelay`, a backoff) the call picks again against the breaker as it is then, so a cooldown another call opened during the wait is respected. A call waits out ejections for at most 2 seconds in total, and otherwise stops with its last error. Probes skip ejected endpoints until the cooldown ends, so a provider that asked for 30 seconds gets them. With three endpoints all returning 429, ten calls cost 16 upstream requests instead of 30, or 17 counting the chain checks. Set `breaker: false` to turn it off, or pass `{ threshold, cooldown, maxCooldown }`.

## Request budgets

Public endpoints limit requests per IP. A budget keeps the transport under that limit instead of finding it with a 429. Give an endpoint `{ url, label, rps, burst }`, or every endpoint without its own a default with `budget: { rps, burst }`. `burst` defaults to `max(1, ceil(rps * 2))`. The official RPC (`https://rpc.hyperliquid.xyz/evm`) gets 1.5 rps with a burst of 3 when neither it nor `budget` sets one, since its per-IP limit is documented. Other endpoints have no budget unless you set one, and `budget: false` turns off every budget, the official one too.

Each budgeted endpoint has a token bucket that starts full, holds `burst` tokens, and refills at `rps` per second. It refills from the clock when it is read, so it needs no timer. Every upstream request spends a token: calls, retries, hedges, chain checks, and head probes. The buckets belong to the factory, so instances built with another timeout or chain spend the same budget. `snapshot()` shows whole tokens left as `tokens`, or `null` for an unlimited endpoint.

Routing skips a spent endpoint while another candidate in the same breaker state has a token. A spent closed endpoint still comes before an ejected one with tokens, so the budget never sends a call into a cooldown. When every candidate is spent, the call waits for the first token. That wait shares the call's 2 second limit with ejection waits. Past it, the call throws `BudgetExhaustedError` with the endpoints' labels and the wait it would have needed, and sends nothing over the limit. If endpoints that already failed this call still have tokens, it starts another round on them first. The all-ejected exception does not override a budget: the first attempt may use an ejected endpoint only when it has a token, and otherwise waits or throws like any other call. A spent endpoint is not sent a chain check. Head probes and hedges skip spent endpoints instead of waiting. A send that waits for a token has not left the process, so non-idempotent methods keep their one-endpoint rule.

The registry does not ship budgets; only the official RPC's is built in. These are the rates the monorepo router uses for one IP. Only the official endpoint's is documented (about 100 requests a minute). The rest are guesses.

| Endpoint | rps |
| --- | --- |
| `https://rpc.hyperliquid.xyz/evm` | 1.5 |
| `https://rpc.purroofgroup.com`, `https://hyperliquid.drpc.org`, `https://999.rpc.thirdweb.com`, `https://rpc.hypurrscan.io` | 10 |
| `https://hyperliquid-json-rpc.stakely.io`, `https://rpc.hyperlend.finance` | 5 |

With the default 4 second probe, head probes alone spend 0.25 rps per endpoint.

## What is not retried

These methods go to one endpoint and are never hedged:

`eth_sendTransaction`, `eth_sign`, `eth_signTransaction`, `eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`, `personal_sign`, `personal_sendTransaction`, `eth_submitWork`, `eth_submitHashrate`, `wallet_sendTransaction`, `wallet_sendCalls`, `eth_subscribe`, `eth_getFilterChanges`, `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`.

`eth_getFilterChanges` returns what changed since the previous poll and consumes it, so re-sending a poll whose response was lost would answer `[]` and drop those changes.

Pass more names in `nonIdempotentMethods`.

`eth_sendRawTransaction` and `eth_sendRawTransactionSync` are never hedged either, but they fail over on endpoint errors. Sending the same signed bytes again has the same hash, and the nonce stops a second execution. On a re-send, an "already known" answer means an earlier attempt landed, so `eth_sendRawTransaction` returns `keccak256` of the bytes. The Sync variant throws instead, since no receipt can be built from that answer. "nonce too low" on a re-send is thrown: the earlier attempt may have landed, and the transport does not look it up. Set `rebroadcastRawTransactions: false` to send them once.

Failover stops on execution reverts, invalid params, invalid requests, parse errors, transaction rejections (nonce, funds, gas, fee, sender, already known), user rejections, and caller aborts. These are the endpoint answering about the call, so they count as a healthy answer, not an endpoint error. Some providers report `eth_getLogs` range and result limits as invalid params (`-32602`). When the message describes a block range, result count, response size, or query timeout limit, the call fails over, since another endpoint may allow more. A node that has not reached the block a call names answers `header not found`, `unknown block`, or, on the official HyperEVM RPC for `eth_getLogs`, `-32602 invalid block range`. Those fail over too, since a node a block ahead may hold it, and they cost the endpoint no breaker strike or error sample: it is behind, not sick, and probes score the lag. An inverted range gets the same text from some nodes, so it costs a few extra requests before every endpoint rejects it alike. A timeout, a reset connection, a rate limit, an internal error, or "method not found" tries the next endpoint, up to `retryCount` extra attempts (default 2).

Each endpoint is tried once before any is tried again. Once every eligible endpoint has failed a call and attempts remain, the call waits a jittered exponential backoff and starts another round. The base is `retryDelay`, or 100ms when it is 0. Each wait is half to all of `base * 2^round`, capped at 2 seconds, and at least the ejection left on the endpoint it will try. A call stops rather than wait out a longer ejection. With the default `retryCount`, a single endpoint survives one 429.

Hedging is off unless you set `hedge`. When it is on, an idempotent read that is still running after `max(minDelay, multiplier * tail)` is copied to the next endpoint. The first success wins. Cancelling the loser does not count as an error. Hedges never go to an ejected endpoint. A backup that has not passed its chain check is checked first, then hedged if the read is still running, so hedging works with probes off.

## Racing

Racing is on by default at width 2; `race: false` turns it off. It costs `width` upstream requests per read, which counts against public rate limits and paid-provider quotas. With the default, `race: true` (width 2), or `race: { width }`, the first attempt of an idempotent read goes to the best-scored endpoints at once, in score order rather than by power of two choices. The first answer wins. A racer that fails does not fail the call while another is still running. A terminal answer (a revert, invalid params, a caller abort) settles the race at once, since the failover loop would stop on it anyway. A racer that has not reached the block the read names is not terminal, so the race waits for the other racer. When every racer fails, the call fails over to endpoints it has not tried, and `AllEndpointsFailedError` holds each racer's error. Later attempts do not race.

Only endpoints that have passed their chain check, are not quarantined, are not ejected at dispatch, and hold a budget token are raced. An unverified endpoint is skipped and checked in the background, so the next call can race it, unless it is out of budget. A race never waits for a token, so a spent endpoint narrows it instead. When every endpoint is ejected, the availability exception sends the first attempt to one endpoint and nothing races. Sends and the other methods in [What is not retried](#what-is-not-retried) never race.

Losers are not cancelled. They run to their own deadline and record their latency and errors like any call, so each race re-measures the runner-up and the ranking follows whichever endpoint is fastest now. A loser the caller aborts records nothing, and its in-flight count ends with it. A `race` event lists the racers, best first, and each racer also gets a `request` event. With `hedge` on as well, the hedge adds the next endpoint after its delay on top of the racers.

## Pinned latest

Endpoints a block or two apart answer `"latest"` for different blocks. A client that reads `eth_blockNumber` from one node and then asks another for `eth_getLogs` from that block can get an invalid-range error, or logs that stop short. `pinLatest` is on by default; `pinLatest: false` turns it off. With it on, an idempotent read's `"latest"` tag, given or implied, is rewritten to a concrete block, and the read is sent only to endpoints known to hold it. Heads only go up, so the last head seen from an endpoint is a block it holds even once that reading is old. The block is the lowest trusted head among the endpoints that may serve the call: those that passed their chain check, are not quarantined or ejected, support the method, and are within `maxLag` of the highest such head. At least one of those heads must be from the last `freshMs` (default 1000), or the tag passes through. A head ignored as implausible does not count. Every attempt, race, failover, and hedge of one call uses the same block, and none of them goes to an endpoint whose head is below it, that has no head yet, or that has not passed its chain check.

The tag is found in `eth_call`, `eth_getBalance`, `eth_getCode`, and `eth_getTransactionCount` (param 1), `eth_getStorageAt` (param 2), `eth_getBlockByNumber` (param 0), `eth_feeHistory` (param 1), `eth_estimateGas` (param 1, only when given, since some nodes estimate against `"pending"` without one), an EIP-1898 `{ blockNumber: "latest" }`, and an `eth_getLogs` filter's `fromBlock` and `toBlock`, where an omitted bound means `"latest"`. A filter with `blockHash` is left alone, and so is a range that pinning would invert, such as a `fromBlock` above the pinned block. `"pending"`, `"safe"`, `"finalized"`, `"earliest"`, numbers, and `{ blockHash }` are never changed. The caller's params are copied, not mutated. Methods in the non-idempotent list are never pinned.

While a pin exists, `eth_blockNumber` is answered locally with the same block, so the number a client reads is one the next read can be served at. Otherwise it goes upstream, and the answer is lowered to the block a pinned read would use once it counts as a head. Answers from one instance never go backwards, upstream ones included. Once a block has been returned, pinned reads use it, not a lower one, while an endpoint holds it: an endpoint that rejoins at a lower head serves pinned reads again once it catches up. Set `pinLatest: { blockNumber: false }` to keep `eth_blockNumber` upstream. Heads come from probes and from `eth_blockNumber` answers, so pinning works with `probeInterval: false`: a stale head sends the next `eth_blockNumber` upstream, and its answer is fresh again. With `headLag: false` there are no heads, and pinning does nothing.

With the default 4 second probe interval, probe heads alone are fresh about a quarter of the time, so a pin exists only that often unless calls refresh heads.

HyperCore read precompiles (`0x0000…0800` to `0x0000…08ff`) answer from current HyperCore state whatever block they are given, so `eth_call`s to them are not pinned, and identical ones share a request across blocks. On the official HyperEVM RPC a state read such as `eth_getBalance` at a block it has not reached answers with current state rather than an error, and only `eth_getLogs` rejects it. Pinning makes the logs consistent there, not those reads.

## Coalescing

Identical idempotent reads that are in flight at the same time share one upstream request. Two calls are identical when the method and params match, with object keys sorted. A bigint param never matches a string or number param. The shared request goes through the same routing, failover, breaker, and chain checks as any call, and every caller gets its result or its error. A caller that joins fires a `coalesce` event and sends nothing of its own. The entry is dropped as soon as the request settles, so nothing is cached and memory is bounded by the calls in flight. Each `hyperevm()` instance has its own table.

Sends, methods in the non-idempotent list or `nonIdempotentMethods`, subscriptions, and filter methods (`eth_newFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter`, and the rest) never share a request.

Each caller waits under its own abort signal. A caller that aborts is rejected with its own reason, and the others keep waiting. The shared request is cancelled only when every waiting caller has aborted. A caller without a signal keeps it running. A cancelled request leaves the table at once, so a later caller starts a fresh one and never inherits an aborted signal. A request whose first caller has no signal is sent without one, so viem's HTTP batching still groups it. Requests started by callers that share one signal are sent under one signal of their own, so they batch together too, and it aborts once every one of them has lost its callers. On Workers the invocation that started a request can end and take it with it, so its promise may never settle. A caller waits on another caller's request for one `timeout` plus a grace (the smaller of `timeout` and 1 second) without news from it, then starts its own, and the old request is not joined again. Each attempt, failover, and backoff of the shared request moves that deadline out, so its callers wait through a failover instead of sending the read again.

Set `coalesce: false` to send every call.

## Warm start

A new instance starts cold: every endpoint scores as `priorMs` until it answers. `value.scores()` returns what the instance has learned as versioned JSON (`version: 1`, `savedAt`, and each endpoint's books by label and method, with `"*"` for the global book). `value.restoreScores(snapshot)` seeds a new instance from it. Heads, breaker state, and chain checks are never saved, so a new session probes heads, re-checks `eth_chainId` before an endpoint's first call, and starts with every circuit closed.

A restored book is a prior. It fills only a book with no samples, counts as at most two samples, so its score blends back toward `priorMs` and it never sets a hedge delay, and the endpoint's first live sample replaces it instead of mixing in. A probe moves its error and tail like any book, but does not replace it. A book saved again before a live sample replaced it keeps the time it was first measured, so it still ages out.

Storage is untrusted. Restore accepts a snapshot or its JSON (at most 256 KiB), ignores unknown endpoint labels, method names that are not identifiers, more than 32 books per endpoint, books with a missing or non-finite field, and snapshots or books older than `maxAge` (default 1 hour) or more than a minute in the future. Latencies are clamped to the instance's `timeout`, error rates to 0 to 1.

`persist: { load, save }` does this for you. `load` runs once, on the instance's first request, so building a client at module scope on Workers does no I/O. A load that returns synchronously, or a promise that has already settled, seeds the first pick. A slower one lands when it settles and never delays or fails a call. `save` runs at most every `saveInterval` (default 10 seconds) on an unref'd timer, and on `close()`. Nothing is saved until the load settles, so a slow load cannot be overwritten by an empty snapshot. A load still pending after one `timeout` stops holding saves back and fires a `persist` event: on Workers a load started by an invocation that ended never settles. A later request re-arms a save timer the runtime cancelled with its invocation. A load or save that throws or rejects, or a stored value that is not a snapshot, fires a `persist` event. `localStoragePersistence(key)` uses `globalThis.localStorage`, and loads and saves nothing where it is missing or blocked (Workers, Node, React Native, private modes). Snapshots carry labels, never key-bearing URLs.

## Read cache

A round trip to any HyperEVM RPC takes tens of milliseconds, so a read answered in under a millisecond has to come from memory. `cache` is on by default; `cache: false` sends every read upstream. With it on, an idempotent read may be answered from memory with data at most `maxStaleBlocks` (default 1) behind the newest head the transport knows, and younger than `maxAgeMs` (default 2000). HyperEVM makes a small block about every second and has instant finality: HyperBFT finalizes a block when it is made, and there are no reorgs. So an answer is correct for the block it was read at, and anything named by a block number or hash never changes. The cache needs `headLag`: the head is what bounds staleness. It is best with `pinLatest`, which names the exact block each read was answered at.

Each `"latest"` read (`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, and `eth_getBlockByNumber("latest")`) is keyed by its method and params with the block tag normalized, so an implied `"latest"`, an explicit one, and the block number the pin would write share one entry. Hex strings are lower-cased in the key. The entry is stamped with the block the read was pinned to, or, for a block fetched at `"latest"`, the block's own number. Without `pinLatest` a read can reach any endpoint, so the stamp is the lowest head among the endpoints that could have served it, which may be too far behind to serve. A read at an explicit block number hits the `"latest"` entry when that is the block it was read at, which is what a client that pins for itself from `eth_blockNumber` asks for. The newest head is the highest trusted head among the endpoints that may serve the method. A head the scoreboard ignores as implausible is never served from.

Reads at a block number at or below the newest head, `eth_getBlockByNumber` with a number, `eth_getBlockByHash`, `eth_getTransactionByHash` once mined, a non-null `eth_getTransactionReceipt`, the by-hash transaction count and index lookups, `eth_getLogs` with a `blockHash`, and `eth_chainId` are kept for good, in the same LRU. A state read at an explicit block is kept only when every endpoint that could have answered is known to hold that block: the official RPC answers a state read at a block it has not reached with current state rather than an error, and a pinned read is routed to holders, but an explicit number is not. A null answer is never kept.

HyperCore read precompile calls (`0x…0800` to `0x…08ff`) read current HyperCore state whatever block they name, so their entries are bounded by `maxAgeMs` only, keyed without the tag, and re-read on every tick while hot.

Never cached: sends and everything in [What is not retried](#what-is-not-retried) or `nonIdempotentMethods`, `eth_getTransactionCount` at `"latest"` or `"pending"` (a stale nonce breaks the next send), `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, the filter methods, subscriptions, any read at `"pending"`, `"safe"`, `"finalized"`, or `"earliest"`, and errors. A revert is not kept either: it costs no more than a success to re-read, and a cached error object would be thrown to several callers at once.

A hit returns a deep copy, and a stored answer is a deep copy, so a caller that changes what it got cannot change what the next caller gets. Entries are bounded by `maxEntries` (default 1000) and about `maxBytes` (default 8 MiB), least recently used first out. Each `hyperevm()` instance has its own cache, so factories with different endpoints or chains never share one.

### Hot keys and refresh

Every `"latest"`, precompile, and log read keeps its key hot. The list holds `hotKeys` (default 64) keys, least recently read first out, and a key not read for `hotIdleMs` (default 30 seconds) leaves it. Whenever the transport learns a new head, from a probe, a call, or the tick, each hot key whose entry is behind it, or about to pass `maxAgeMs`, is read again in the background, pinned to the newest head and sent only to the endpoints at it, whether or not `pinLatest` is on. A refresh goes through the same shared request table as a call, so a call that misses while its refresh is in flight joins it, but a refresh is never raced or hedged, and one key has at most one refresh in flight. A refresh that fails leaves the old entry, which still serves within `maxStaleBlocks`. A refresh is skipped when the page is hidden (`isActive`) and when no endpoint that could serve it holds a budget token, and it respects the breaker, quarantine, and chain checks like any call.

While keys are hot, a tick every `refreshInterval` (default 1000 ms) sends one `eth_blockNumber` to the best-scored verified, closed, funded endpoint, since the default 4 second probe would see every fourth block. Like a probe it scores liveness, not latency. The tick stops when the last key goes idle, and restarts on the next cacheable read. On Workers a timer dies with the invocation that set it, so a request re-arms a tick that is past due. `refreshInterval: false` sends no ticks; hot keys are still refreshed when a probe or a call brings a new head.

The cost is one request per tick plus one per hot key per new head: with `n` hot keys and a block a second, about `60 * (1 + n)` upstream requests a minute while the keys are hot, and nothing once they are idle. A live run with four hot keys measured about 370 a minute, three times the uncached transport's, and is in [benchmarks.md](benchmarks.md#read-cache). A longer `refreshInterval` with a matching `maxStaleBlocks`, a shorter `hotIdleMs`, or viem's `batch` option (which folds one round's reads to an endpoint into one HTTP request) each lower it.

### Logs

For each log filter seen recently (address and topics), the cache keeps an index of the filter's logs over a rolling window of the last `logsWindow` (default 1000) blocks, which is also the widest range the public providers accept. A range query seeds it, and each new head extends it by the new blocks only, `head − lastIndexed` of them, so a client that polls a 980-block window never has a provider scan that window again. A query whose range lies inside the index is answered from memory, filtered to the range, in block then log index order. A query ending at `"latest"` is served while the index is within `maxStaleBlocks` of the newest head and younger than `maxAgeMs`; one ending at a number is served whenever the index covers it. A query that starts inside the index but ends beyond it fetches the missing tail, merges it, and answers from the index. Anything else goes upstream and seeds or widens the index when its range touches the indexed one. A client that scans forward from the last block it saw should set `maxStaleBlocks: 0`, or a log in the newest block could be missed by a query that moves past it. An explicit end block is indexed only when every endpoint that could have answered holds it. A filter with `blockHash` is an immutable entry instead.

### eth_blockNumber

With the cache on, `eth_blockNumber` is answered locally from the newest trusted head while its reading is younger than `maxAgeMs`, and never goes backwards. With `pinLatest` the pinned block comes first while a head is fresh, and the cache's answer is lowered to it the same way an upstream answer is, so the number a client reads is one its next read is served at. Before the cache, with the 4 second probe and `freshMs` of 1 second, the pin had a fresh head to answer from only about a quarter of the time, and the rest of the calls went upstream: that is why a "locally answered" `eth_blockNumber` still had a p50 of tens of milliseconds. The tick keeps a head under a second old while keys are hot.

### Telemetry

`value.cacheStats()` returns `hits`, `misses`, `refreshes` (background reads started), `entries`, `bytes`, and `hotKeys`. A `cache` event fires for every cacheable read with `outcome` `hit`, `miss`, or `refresh`; on a hit, `staleBlocks` is how far behind the newest known head the answer was, or null for a precompile read.

## Combining the router features

Racing, pinning, coalescing, budgets, warm start, the activity pause, and the read cache are separate options, and they compose in one order. A request first loads stored scores (`persist`), then looks in the cache (`cache`), then pins `"latest"` (`pinLatest`), then joins or starts a shared request (`coalesce`), and only the shared request routes, races, hedges, and fails over. A miss is stored at the block it was pinned to once the shared request answers. So:

- Two spellings of one read that pin to the same block, such as an implied `"latest"`, an explicit one, and the pinned block number, share one request. A race is never joined halfway: callers join above it.
- Every racer, hedge, and failover of a pinned read is sent the same block.
- Racers, hedges, chain checks, and probes each spend a budget token. A spent endpoint is not raced, hedged, checked, or probed.
- A locally answered `eth_blockNumber` sends nothing, so it spends no token and is not coalesced.
- Restored scores feed the same scoreboard racing reads, so the first race of a session goes to the endpoints that were fastest last time.
- While `isActive()` is false, probe ticks send nothing, and once active they still skip spent and ejected endpoints.
- Methods that are not idempotent are never raced, pinned, coalesced, or cached. Filters and subscriptions are not coalesced or cached either.
- A cache hit sends nothing: it spends no token, is not pinned, raced, hedged, or coalesced, and fires only a `cache` event.
- A cache refresh is pinned to the newest head and sent to its holders alone, through the shared request table, so a call that misses joins it. It is never raced or hedged, spends one token, and is skipped while the page is hidden or the holders are spent.
- `close()` stops the probe timer and the cache tick, removes the visibility listener, and saves scores once.

| Option | Default | Section |
| --- | --- | --- |
| `race: boolean \| { width }` | on, width 2 | [Racing](#racing) |
| `pinLatest: boolean \| { freshMs, blockNumber }` | on. `freshMs` 1000, `blockNumber` true | [Pinned latest](#pinned-latest) |
| `coalesce: boolean` | on | [Coalescing](#coalescing) |
| `budget: { rps, burst } \| false`, endpoint `{ rps, burst }` | official RPC 1.5 rps, burst 3; others none. `burst` is `max(1, ceil(rps * 2))` | [Request budgets](#request-budgets) |
| `persist: { load, save, maxAge, saveInterval }` | off. `maxAge` 1 hour, `saveInterval` 10 seconds | [Warm start](#warm-start) |
| `isActive: () => boolean` | false only in a hidden browser tab | [Inactive pages and apps](#inactive-pages-and-apps) |
| `cache: boolean \| { maxStaleBlocks, maxAgeMs, refreshInterval, hotKeys, hotIdleMs, maxEntries, maxBytes, logsWindow }` | on. `maxStaleBlocks` 1, `maxAgeMs` 2000, `refreshInterval` 1000, `hotKeys` 64, `hotIdleMs` 30000, `maxEntries` 1000, `maxBytes` 8 MiB, `logsWindow` 1000 | [Read cache](#read-cache) |

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
- Race, pinning, and the cache default on. Together they cost about three times the upstream requests of a plain transport (see [benchmarks.md](benchmarks.md#read-cache)). A server-side deployment that shares one IP across many users may want `race: false` or a longer `refreshInterval`.
- With `pinLatest` on, a pinned `eth_getBlockByNumber("latest")` is sent as a numbered fetch, so it no longer refreshes heads. Probes and upstream `eth_blockNumber` answers still do.
- Hedge defaults off. A stall study is in [benchmarks.md](benchmarks.md). The cold hedge fires at `minDelay` (250ms), and several public nodes are slower than that, so those first calls would be duplicated.
- The shipped history starts with one probe run. Full weight waits for the window above, so every endpoint in the first ranked file is on the new-node cap. The shipped file predates the precompile and range probes, so it reflects them only after the next `bun run rank`. Production services should pass explicit endpoints.
- Snapshots do not show ejection state. Watch the `eject` and `restore` events.
- A browser tab that closes without `close()` loses up to `saveInterval` of learning. Save `value.scores()` yourself on `pagehide`. `close()` saves too, but a page restored from the back-forward cache would find the transport closed. Instances of one factory with different timeouts share a `persist` store, and the last one to save wins.
- `close()` does not close a child `webSocket()` transport's socket or cancel calls in flight.
- Filters are not pinned to the node that made them. `eth_new*Filter` goes to one endpoint and is never retried, but a later `eth_getFilterChanges` may be routed elsewhere and answer "filter not found". Poll with `eth_getLogs` instead. viem's `fallback` has the same gap.
- One factory shares an instance per `timeout`, `retryCount`, and chain, and keeps it until `close()`. Clients built with a different timeout per request each get their own instance. Fix those options when the factory is created.
- The cache serves a `"latest"` read up to `maxStaleBlocks` behind the newest head, and a log query ending at `"latest"` may leave out the newest block's logs within that bound. A forward scanner should set `maxStaleBlocks: 0`. The cache counts on instant finality: on a chain with reorgs, immutable entries would be wrong.
- Cache refreshes on Workers run in the invocation that saw the new head, and die with it. Entries then expire by `maxAgeMs` and the next read goes upstream. There is no `waitUntil` hook.
- The cache does not bound a precompile answer by HyperCore time: `maxAgeMs` is the only bound, and the tick re-reads it about once a second.
- Error redaction replaces exact spellings of a key-bearing URL. A provider that echoes the bare key elsewhere in an error is not scrubbed.
- The simulated comparison with viem `fallback` is in [benchmarks.md](benchmarks.md). A live run is a manual workflow, not part of CI.
