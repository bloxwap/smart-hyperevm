<p align="center">
  <strong>Latency-aware typescript
    <a href="https://github.com/bloxwap/hyperevm">HyperEVM RPC transport</a></strong>
</p>

<p align="center">
  <a href="https://github.com/bloxwap/hyperevm/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/hyperevm?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@bloxwap/hyperevm"><img alt="npm" src="https://img.shields.io/npm/v/@bloxwap/hyperevm?style=flat-square"></a>
</p>

## Features

| Feature            | Value                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| Adaptive routing   | Routes by per-method latency, errors, load, and block lag.                  |
| Racing & failover  | Parallel reads, hedging, retries, circuit breakers, and rate-limit budgets. |
| Warm cache         | Sub-millisecond reads, background refresh, and local block numbers.         |
| Incremental logs   | Rolling 1,000-block index; fetches only new blocks.                         |
| Consistent reads   | Pins `"latest"` across endpoints.                                           |
| Request efficiency | Coalescing, HTTP batching, and memoized hot paths.                          |
| Lifecycle          | Saved scores, hidden-tab pause, and idle shutdown.                          |
| Integration        | TypeScript, drop-in viem transport, and offline CI tests.                   |
| Runtimes           | Bun, Node.js, browsers, and edge; no runtime dependencies beyond peer viem. |

## Performance

One live HyperEVM run compared `hyperevm()` defaults with direct viem `http()` connections to four public RPC providers. The workload combined block-number, multicall, precompile, log, and balance reads. Latencies are p95 at the transport's `request`; lower is better.

| Transport                   | Sequential, all reads | Sequential, warm reads | Concurrent, mostly warm | Errors (sequential / concurrent) |
| --------------------------- | --------------------: | ---------------------: | ----------------------: | -------------------------------: |
| **`hyperevm()` (defaults)** |                129 ms |            **0.17 ms** |             **0.10 ms** |                      **0% / 0%** |
| Hyperliquid (direct)        |                149 ms |                 149 ms |                  189 ms |                        75% / 90% |
| HypurrScan (direct)         |                196 ms |                 196 ms |                  185 ms |                          0% / 0% |
| dRPC (direct)               |                218 ms |                 223 ms |                  224 ms |                        20% / 20% |
| Stakely (direct)            |              2,104 ms |               2,318 ms |                1,482 ms |                          0% / 1% |

Warm columns exclude the first iteration; direct providers do not cache. Cold reads still require the network, and the concurrent phase started with a warm `hyperevm()` cache. Cached answers can be one block behind by default, and background refreshes increase upstream traffic. See the [full benchmark methodology and results](https://bloxwap.github.io/hyperevm/docs/benchmarks/#direct-provider-comparison).

## Documentation

Browse the [full documentation](https://bloxwap.github.io/hyperevm/docs/) for configuration, routing, caching, telemetry, and benchmarks.

## Installation

### Bun

```sh
bun add @bloxwap/hyperevm
```

### Node.js 22.12+

```sh
npm i @bloxwap/hyperevm
```

### pnpm

```sh
pnpm add @bloxwap/hyperevm
```

### Yarn

```sh
yarn add @bloxwap/hyperevm
```

## Quick Example

### Read

```ts
// 1. Import module
import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Set up client with transport
const client = createPublicClient({
  chain: hyperEvm,
  transport: hyperevm(),
});

// 3. Query data
const block = await client.getBlockNumber();
```

### Configure

```ts
// 1. Import modules
import { http } from "viem";
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Set up transport with your endpoints
const transport = hyperevm({
  endpoints: ["https://rpc.hyperliquid.xyz/evm", http("https://rpc.hypurrscan.io", { batch: true })],
});

// 3. Use it from a viem client
// createPublicClient({ chain: hyperEvm, transport })
```

Hedging is off unless you set `hedge`. When it is on, a slow idempotent read is copied to the next endpoint and the first success wins. Racing is on by default: each idempotent read goes to the two best-scored endpoints at once (`race: { width }` for more, `race: false` for one), and the first answer wins. Sends are never hedged or raced. Signed raw transactions fail over on endpoint errors. Other sends go to one endpoint.

### Production

Use explicit, trusted endpoints in services and create the transport once per process or Worker isolate.

```ts
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  endpoints: [
    { url: env.HYPERPC_URL, label: "hyperpc" },
    { url: env.DRPC_URL, label: "drpc" },
    "https://rpc.hyperliquid.xyz/evm",
  ],
  timeout: 3_500,
  hedge: true,
});
```

- On Workers, set `headLag: { probeInterval: false }` to avoid timers outside requests.
- Racing, pinning, coalescing, and caching are on by default. Cached answers may be one block behind and increase upstream traffic; forward log scanners should use `cache: { maxStaleBlocks: 0 }`.
- Set endpoint `rps` and `burst` values to stay within provider rate limits.
- Call `transport.value.close()` on shutdown to stop timers and save persisted scores.

See [all options and defaults](https://bloxwap.github.io/hyperevm/docs/routing/#combining-the-router-features).

### Observe

```ts
const transport = hyperevm({
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});
```

Use `onEvent` for telemetry and `transport.value.snapshot()` for current routing state.

> [!WARNING]
>
> - Load private RPC URLs from the environment and never commit credentials. Events and errors expose labels rather than keyed URLs.
> - Signed raw transactions may be rebroadcast after endpoint errors. Set `rebroadcastRawTransactions: false` to send only once.
> - This package routes JSON-RPC; it does not sign transactions or hold a wallet.
