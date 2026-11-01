<h1 align="center">HyperEVM RPC</h1>

<p align="center"><strong>Latency-aware JSON-RPC transport for HyperEVM. A viem <code>Transport</code> that ranks endpoints from the calls your process already made.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/smart-hyperevm?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@bloxwap/smart-hyperevm"><img alt="npm" src="https://img.shields.io/npm/v/@bloxwap/smart-hyperevm?style=flat-square"></a>
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

One live HyperEVM run compared `smartHyperevm()` defaults with direct viem `http()` connections to four public RPC providers. The workload combined block-number, multicall, precompile, log, and balance reads. Latencies are p95 at the transport's `request`; lower is better.

| Transport                        | Sequential, all reads | Sequential, warm reads | Concurrent, mostly warm | Errors (sequential / concurrent) |
| -------------------------------- | --------------------: | ---------------------: | ----------------------: | -------------------------------: |
| **`smartHyperevm()` (defaults)** |                129 ms |            **0.17 ms** |             **0.10 ms** |                      **0% / 0%** |
| Hyperliquid (direct)             |                149 ms |                 149 ms |                  189 ms |                        75% / 90% |
| HypurrScan (direct)              |                196 ms |                 196 ms |                  185 ms |                          0% / 0% |
| dRPC (direct)                    |                218 ms |                 223 ms |                  224 ms |                        20% / 20% |
| Stakely (direct)                 |              2,104 ms |               2,318 ms |                1,482 ms |                          0% / 1% |

Warm columns exclude the first iteration; direct providers do not cache. Cold reads still require the network, and the concurrent phase started with a warm `smartHyperevm()` cache. Cached answers can be one block behind by default, and background refreshes increase upstream traffic. See the [full benchmark methodology and results](https://bloxwap.github.io/smart-hyperevm/docs/benchmarks/#direct-provider-comparison).

## Installation

### Bun

```sh
bun add @bloxwap/smart-hyperevm
```

### Node.js 22.12+

```sh
npm i @bloxwap/smart-hyperevm
```

### pnpm

```sh
pnpm add @bloxwap/smart-hyperevm
```

### Yarn

```sh
yarn add @bloxwap/smart-hyperevm
```

## Release status

`0.1.0` is an early developer preview. Expect breaking changes before `1.0`.

## Usage

### Read

```ts
import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { smartHyperevm } from "@bloxwap/smart-hyperevm";

const client = createPublicClient({
  chain: hyperEvm,
  transport: smartHyperevm(),
});

const block = await client.getBlockNumber();
```

With no arguments, `smartHyperevm()` calls the eligible HTTP rows in [`packages/smart-hyperevm/registry/nodes.json`](packages/smart-hyperevm/registry/nodes.json). HyperEVM mainnet is chain id 999.

### Configure

```ts
import { http } from "viem";
import { smartHyperevm } from "@bloxwap/smart-hyperevm";

const transport = smartHyperevm({
  endpoints: ["https://rpc.hyperliquid.xyz/evm", http("https://rpc.hypurrscan.io", { batch: true })],
  hedge: { minDelay: 250, multiplier: 2 },
});
```

URL strings are wrapped in viem's `http()`, or `webSocket()` when the URL is `wss://`. A transport you pass in keeps the batching it was created with. Pass provider URLs as strings or `{ url, label }` rather than `http(url)`: viem drops the headers of a 429 or 503 whose body is a JSON-RPC error, so only a transport built from a URL keeps its `Retry-After`. Idempotent reads fail over on timeout, rate limit, and connection loss. Once every endpoint has failed a call, the transport backs off and tries again while `retryCount` allows. An endpoint that keeps failing is ejected for a cooldown.

`eth_sendRawTransaction` and `eth_sendRawTransactionSync` fail over on endpoint errors, because the same signed bytes have the same hash and the nonce stops a second execution. They are never hedged. The other non-idempotent methods go to one endpoint.

Before an endpoint serves its first call, the transport checks `eth_chainId` against the client chain (999 when there is none). An endpoint on another chain is quarantined and gets no calls.

### Production

Use explicit, trusted endpoints in services and create the transport once per process or Worker isolate.

```ts
import { smartHyperevm } from "@bloxwap/smart-hyperevm";

const transport = smartHyperevm({
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

### Observe

```ts
const transport = smartHyperevm({
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});
```

Use `onEvent` for telemetry and `transport.value.snapshot()` for current routing state.

## Documentation

Browse the [full documentation](https://bloxwap.github.io/smart-hyperevm/docs/) for configuration, routing, caching, telemetry, and benchmarks. Public endpoint submissions are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Run `bun dev` (or `bun run docs:dev`) from the repository root to start the documentation site in Turbo's terminal UI at [localhost:3915](http://localhost:3915); use `bun dev --ui=stream` for plain logs. `bun run docs:build` writes its static export. `bun run rank` updates the registry from live public-endpoint probes.

## Security

- Load private RPC URLs from the environment and never commit credentials. Runtime events and errors expose labels rather than keyed URLs.
- Signed raw transactions may be rebroadcast after endpoint errors. Set `rebroadcastRawTransactions: false` to send only once.
- This package routes JSON-RPC; it does not sign transactions or hold a wallet.

## License

[MIT](LICENSE)
