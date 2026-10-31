# Benchmarks

`hyperevm()` and viem `fallback` ran the same 120-call read mix through in-process endpoints. The clock advances only when a mock handles a call, so this page is reproducible in CI (`bun test tests/bench`). A separate 20-call hedge study uses wall-clock timers, because hedging is a real `setTimeout`.

No default changed. The tables are the reason.

## Workload

Each row is 120 sequential calls, a 10-call cycle repeated 12 times:

| Method | Calls | Latency |
| --- | --- | --- |
| `eth_call` | 48 | 1x |
| `eth_call` batch | 12 | 3x, standing in for one HTTP batch |
| `eth_getLogs` | 24 | 1.8x |
| `eth_getBlockByNumber` | 12 | 1x |
| `eth_blockNumber` | 12 | 1x |
| `eth_getBalance` | 12 | 1x |

The batch row is one heavier call. These mocks are not viem's HTTP batcher, so they cannot coalesce several JSON-RPC calls into one POST. URL endpoints in the real transport still pass `batch` through to viem `http()`.

Latency is the user-visible total, including a failed attempt before failover. Error rate is user calls that threw. Stale rate is successful calls served by a node more than 2 blocks behind the tip. Busiest share is the busiest endpoint's attempts divided by all user attempts. Head probes are not counted as user attempts.

`hyperevm` calls `value.probe()` once before each user call. That is the same function the 4 second timer calls. The timer stays off here, so the virtual clock is the only schedule. The simulation also sets `breaker: false` and `verifyChainId: false`, so the tables measure scoring alone. With the breaker on, the dead node is ejected after three failures, and the dead-first p2c row drops from a median of 72 / p95 288 / p99 480 to 40 / 120 / 120. A process that calls faster than the timer will still send a user call to a node the probe has not failed yet. viem `fallback` has no head probe. `rank: true` is also not this table: that option reorders on a timer after `net_listening` pings, and a virtual clock never fires the timer. The "after one ping sort" row is the list order those pings would produce, held still for the whole run.

## Dead node first

Order: a node that always fails in 12ms, a fresh node at 40ms, a slow fresh node at 160ms.

| Transport | median | p95 | p99 | errors | failovers | stale | busiest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fallback` | 52 | 156 | 156 | 0 | 120 | 0% | 50% |
| `hyperevm` p2c | 72 | 288 | 480 | 0 | 0 | 0% | 58.3% |
| `hyperevm` best | 40 | 120 | 120 | 0 | 0 | 0% | 100% |

`fallback` pays the dead hop on every call (12ms, or 36ms on a batch) and then uses the fresh node. The probe has already marked that node down before `hyperevm` sends the user call, so those rows show zero user failovers.

`best` then stays on the 40ms node: median 40, batch median 120, `eth_getLogs` median 72. `p2c` still draws the 160ms node, so its median rises to 72 and its batch tail reaches 480. The spread is real (busiest share 58% instead of 100%) and the tail is the cost.

## Fast node, stale head

Order: the dead node, a node at 22ms whose head is 8 blocks behind, a node at 45ms that fails every 5th attempt, and a fresh node at 85ms.

| Transport | median | p95 | p99 | errors | failovers | stale | busiest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fallback` | 34 | 102 | 102 | 0 | 120 | 100% | 50% |
| `fallback` after one ping sort | 22 | 66 | 66 | 0 | 0 | 100% | 100% |
| `hyperevm` p2c | 85 | 255 | 390 | 0 | 5 | 25.8% | 54.4% |
| `hyperevm` best | 85 | 255 | 255 | 0 | 0 | 0% | 98.3% |

The ping sort puts the 22ms node first and leaves it there. Every successful read is stale. `hyperevm` with `best` serves the fresh 85ms node (stale rate 0, `eth_getLogs` median 153). `p2c` still sends about a quarter of successes to the stale node (7 of 48 `eth_call`s, 31 of 120 overall) and keeps the busiest endpoint at 54% of attempts. Five user calls fail over.

Raising `lagWeight` from 1 to 2 copies the `p2c` row exactly. `latencyMix` 0.4 (more tail, less mean) raises the stale rate to 26.7% and does not improve the median. Those knobs stay at the defaults.

## Hedge

Twenty `eth_call`s. The first endpoint answers in 30ms, except every 5th attempt, which takes 200ms. The second answers in 30ms. Hedge wait is `minDelay` 40ms until three samples exist, then `max(40, 2 * tail)`. This is wall clock. The milliseconds below are from the run that wrote this page. CI checks the shape: hedge cuts p99, both sides return every call, and the hedged pass stays under twice the attempts.

| | median | p95 | p99 | attempts |
| --- | ---: | ---: | ---: | ---: |
| hedge off | 30 | 200 | 201 | 20 |
| hedge on | 30 | 31 | 71 | 21 |

One extra attempt, and the stalled tail drops. The first hedged success is enough for `best` to leave the stalling endpoint. That is the study, not a load test.

Hedge stays off. The production `minDelay` is 250ms, and the seeded registry includes nodes whose probe latency is well above that (about 1.2s and 1.7s on the current list). A cold hedge fires at 250ms while those calls are still in flight, so the first samples would be sent twice. Callers who want the stall behavior set `hedge: true` or pass `{ minDelay, multiplier }`.

## Defaults left in place

| Knob | Value | Why it stayed |
| --- | --- | --- |
| `routing` | `"p2c"` | `best` wins the tail and the stale rate by putting nearly all attempts on one node. `p2c` is the spread. |
| `hedge` | off | The stall study improves p99. The cold hedge would also duplicate slow public nodes. |
| `lagWeight` | 1 | 2 matches `p2c` on this mix. |
| `latencyMix` | 0.6 | 0.4 does not cut staleness or median. |
| EWMA alphas | 0.4 up / 0.2 down, tail 0.5 / 0.05, error 0.3 | Unchanged. The sweep did not justify a new step size. |

`ScoreConfig` exposes those steps so a later run can sweep them without editing the score function. Passing `score` to `hyperevm()` overrides a field and leaves the rest.

## Live registry

`bun run bench:live` sends two rounds of the six reads above through `hyperevm()` and through viem `fallback` over the eligible HTTP rows in `packages/hyperevm/registry/nodes.json`. Each attempt times out at 4 seconds. The script prints JSON and, when `BENCH_OUT` is set, writes that file.

GitHub Actions runs it only from the manual **Benchmark** workflow (`.github/workflows/benchmark.yml`) and uploads the JSON. It does not run on pull requests, and it does not change the registry.

One pass from this environment on 2026-10-31, twelve calls each, every eligible endpoint answering, no injected failure:

| Transport | median | p95 | errors | failovers | stale block reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| `fallback` | 82ms | 154ms | 0 | 0 | 0 |
| `hyperevm` | 83ms | 291ms | 0 | 0 | 0 |

`fallback` stayed on the first registry row, which was healthy. `hyperevm` spent its first calls sampling other rows, and that is the whole of the p95 gap. Twelve calls on one machine is not a ranking. The tables above are the numbers CI will reproduce.

## Read cache

A temporary script in the papertrade monorepo sent papertrade's read mix through four transports from this environment on 2026-10-31: raw viem `http()` to the official RPC, `hyperevm()` with defaults, `hyperevm()` tuned (`race: { width: 2 }`, `pinLatest: true`, `cache: true`, and an official-RPC budget of 1.5 rps with a burst of 3), and the monorepo router (`new Router(clientUpstreams())` behind `hyperEvmRouterTransport`). Each group is five calls: `eth_blockNumber`, an `eth_call` multicall of five Exchange views, an `eth_call` to the `l1BlockNumber` precompile at `0x…0809`, `eth_getLogs` for the BatchExecutor's `CallExecuted` topic from `head - 979` to `"latest"`, and `eth_getBalance`. The head is the group's own `eth_blockNumber` answer, as in papertrade. Phase 1 ran 20 iterations of one group per transport, at least 2 seconds apart, transport order rotating. Phase 2 ran 10 iterations of two groups at once per transport. Nothing was pre-seeded: the first iteration is cold for every transport, and the cache was not told the workload. The two phases ran back to back, so the cache was warm when phase 2 started. Latencies are milliseconds at the transport's `request`.

Sequential, 20 iterations (118 seconds: the uncached transports' log scans ran past the pace):

| Transport | p50 | p95 | p99 | max | warm p50 | warm p95 | warm p99 | warm max | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| raw official | 127 | 375 | 595 | 4783 | 127 | 375 | 4783 | 4783 | 73/100 |
| `hyperevm` default | 213 | 3164 | 4846 | 5980 | 210 | 3866 | 5980 | 5980 | 0/100 |
| `hyperevm` tuned, cached | 0.05 | 164 | 337 | 1710 | 0.05 | 0.14 | 206 | 206 | 0/100 |
| router | 128 | 617 | 842 | 886 | 127 | 688 | 886 | 886 | 3/100 |

Concurrent, 10 iterations of two groups (48 seconds):

| Transport | p50 | p95 | p99 | max | warm p50 | warm p95 | warm p99 | warm max | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| raw official | 124 | 144 | 236 | 358 | 124 | 144 | 358 | 358 | 85/100 |
| `hyperevm` default | 205 | 2815 | 3072 | 3072 | 211 | 2326 | 3021 | 3021 | 0/100 |
| `hyperevm` tuned, cached | 0.01 | 0.19 | 0.21 | 0.22 | 0.02 | 0.19 | 0.22 | 0.22 | 0/100 |
| router | 125 | 740 | 798 | 798 | 125 | 740 | 798 | 798 | 2/100 |

Per method for the cached transport, p50 / p95 over every iteration: sequential `eth_blockNumber` 0.05 / 0.27, multicall 0.05 / 206, precompile 0.01 / 0.08, `eth_getLogs` 0.11 / 0.48, `eth_getBalance` 0.01 / 0.03; concurrent 0.03 / 0.08, 0.02 / 0.08, 0.01 / 0.01, 0.09 / 0.21, 0.01 / 0.02. The uncached transports' tail is `eth_getLogs`: a 980-block scan takes 2 to 6 seconds on hypurrscan and stakely, and 0.5 to 0.9 seconds through the router.

The sequential p95 over all iterations sits on the cold boundary by construction: 5 of the 100 calls are the first read of each key, and `eth_getLogs` seeds its index with the full 980-block range, which is the 1710 ms maximum. The warm tail is one multicall miss at 206 ms: its refresh was still in flight when the head moved a second block, so the entry fell outside `maxStaleBlocks`. Hit rate was 94% sequential and 100% concurrent. Served answers were at most 1 block behind the newest head the transport knew (p95 1, p50 0).

Upstream HTTP requests a minute, by transport: raw 51 / 126, `hyperevm` default 121 / 128, tuned 370 / 381, router 154 / 219 (sequential / concurrent). The cached transport's requests are the tick (one `eth_blockNumber` a second), the four hot keys refreshed on each new head, and the 4 second probe of every endpoint; with the official RPC budgeted, they went to hypurrscan and drpc almost entirely. That is the trade: three times the uncached transport's load for answers from memory. The raw official run was rate limited on 73% to 85% of calls, as a client without a budget is.
