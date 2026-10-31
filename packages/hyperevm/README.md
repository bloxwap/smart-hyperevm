<p align="center">
  <strong>Latency-aware typescript
    <a href="https://github.com/bloxwap/hyperevm">HyperEVM RPC transport</a></strong>
</p>

<p align="center">
  <a href="https://github.com/bloxwap/hyperevm/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/hyperevm?style=flat-square"></a>
  <img alt="not published to npm" src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square">
</p>

## Features

- **Typed**: Source code is 100% TypeScript.
- **Tested**: Offline unit tests run in CI.
- **Minimal dependencies**: viem is a peer. The package has no runtime dependencies of its own.
- **Cross-Environment Support**: Compatible with Bun, Node.js, and other JS runtimes that provide `fetch`.
- **Integratable**: A drop-in viem `Transport` for `createPublicClient`.

## Documentation

Ranking, failover, and the registry window are described in [`docs/ranking.md`](../../docs/ranking.md) in the [repository](https://github.com/bloxwap/hyperevm). Submitting a node is [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

A documentation site is not published with this package yet.

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

> These commands are the published form. The package is private, so they 404 until a release is approved. Clone the repository to use the source. pnpm can install this directory with `github:bloxwap/hyperevm#path:packages/hyperevm`.

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
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    http("https://rpc.hypurrscan.io", { batch: true }),
  ],
});

// 3. Use it from a viem client
// createPublicClient({ chain: hyperEvm, transport })
```

Hedging is off unless you set `hedge`. When it is on, a slow idempotent read is copied to the next endpoint and the first success wins. Racing is off unless you set `race`. `race: true` sends each idempotent read to the two best-scored endpoints at once, `race: { width }` to more, and the first answer wins. Sends are never hedged or raced. Signed raw transactions fail over on endpoint errors. Other sends go to one endpoint.

### Production

```ts
// 1. Import module
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Build once per process or Worker isolate, with endpoints you trust
const transport = hyperevm({
  endpoints: [
    { url: env.HYPERPC_URL, label: "hyperpc" }, // key in the query
    { url: env.DRPC_URL, label: "drpc" }, // key in the path
    { url: "https://rpc.hyperliquid.xyz/evm", rps: 1.5 }, // about 100 requests a minute per IP
  ],
  timeout: 3_500,
  hedge: true,
  headLag: { probeInterval: false }, // Cloudflare Workers: no timer outside a request
});

// 3. Create clients per request. They share one instance.
// createPublicClient({ chain: hyperEvm, transport })
```

- Keys in explicit URLs are allowed. Events, snapshots, and errors show the `label`, or `scheme://host[:port]`.
- Pass a provider URL as a string or `{ url, label }`, not `http(url)`. viem drops the headers of a 429 or 503 whose body is a JSON-RPC error, so only a transport the package builds from a URL keeps the `Retry-After` the breaker honors.
- Each endpoint's `eth_chainId` is checked before its first call. An endpoint on another chain is quarantined. Set `verifyChainId: false` to skip the check.
- An endpoint with 3 consecutive failures, or a `Retry-After`, is ejected for a cooldown (`breaker`). Routing skips it unless every endpoint is ejected.
- `{ url, label, rps, burst }`, or `budget: { rps, burst }` for every endpoint, keeps requests under a provider's limit with a token bucket. Probes and chain checks spend tokens too. When every endpoint is spent past the 2 second retry budget, the call throws `BudgetExhaustedError`. Default: no budget. The official endpoint allows about 1.5 rps per IP.
- `pinLatest: true` rewrites `"latest"` on reads to a block every servable endpoint holds, sends the read only to endpoints known to hold it, and answers `eth_blockNumber` with it, so a block number from one node is one the next node can serve. HyperCore precompile calls are not pinned, since they ignore the block. Off by default.
- Identical concurrent reads share one upstream request (`coalesce`, default on). Each caller gets its result or error, and nothing is cached after it settles. Sends and filters are never shared.
- `cache: true` answers reads from memory while the answer is at most `maxStaleBlocks` (default 1) behind the newest head and younger than `maxAgeMs` (default 2 seconds). Keys read recently are re-read in the background on each new head, with one `eth_blockNumber` a second finding heads while they are hot. Reads by block number or hash are kept for good, since HyperEVM has instant finality. Recent `eth_getLogs` filters keep a rolling index of the last 1000 blocks, extended by the new blocks only. Sends, nonces at `"latest"`, gas, filters, and errors are never cached. Off by default: it costs about one upstream request per hot key per block. Details in [docs/ranking.md](../../docs/ranking.md#read-cache).
- The probe timer starts on the first request and stops after `headLag.probeIdleTimeout` (60 seconds) without one. `transport.value.close()` stops it, saves scores when `persist` is set, and rejects later requests with `TransportClosedError`.
- Probe ticks pause while `isActive()` is false. In a browser that is a hidden tab, and the page becoming visible probes at once. In React Native, pass `isActive: () => AppState.currentState === "active"`.
- `persist: localStoragePersistence("hyperevm:scores")` warm-starts a browser client from the last session's scores. Pass your own `{ load, save }` for other storage. Restored scores are priors that live samples replace. Heads, ejections, and chain checks are never saved. `value.scores()` and `value.restoreScores()` do the same by hand.
- Racing, pinning, coalescing, budgets, warm start, and the probe pause compose. How, and every default, is in [Combining the router features](../../docs/ranking.md#combining-the-router-features).
- The default registry pool rests on one probe run. Prefer explicit endpoints in a service.

### Observe

```ts
// 1. Import module
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Set up transport with a listener
const transport = hyperevm({
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});

// 3. Read the current scores
// transport({}).value.snapshot()
```

> [!WARNING]
>
> - **Do not commit API keys inside RPC URLs.** The registry rejects credentials and query strings. Load a private endpoint from the environment (Bun auto-loads a local `.env`, which is gitignored in this repo). At runtime the transport accepts key-bearing URLs and only exposes their label.
> - **Raw transactions are rebroadcast.** `eth_sendRawTransaction` fails over on endpoint errors (timeouts, 5xx, rate limits) and is never hedged. A re-send answered with "already known" returns the hash. "nonce too low" is thrown, even when an earlier attempt may have landed. Set `rebroadcastRawTransactions: false` to send once. `eth_sendTransaction` and signing methods go to one endpoint.
> - This package routes JSON-RPC. It does not sign transactions or hold a wallet.
