<h1 align="center">HyperEVM RPC</h1>

<p align="center"><strong>Latency-aware JSON-RPC transport for HyperEVM. A viem <code>Transport</code> that ranks endpoints from the calls your process already made.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/hyperevm?style=flat-square"></a>
  <img alt="not published to npm" src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square">
</p>

## Features

- **Typed.** Source code is 100% TypeScript with comprehensive type safety.
- **Minimal dependencies.** No runtime dependencies of its own. [viem](https://github.com/wevm/viem) is a peer.
- **Cross-environment support.** Compatible with Bun, Node.js, browsers, and edge runtimes that provide `fetch`.
- **Easy integration.** `hyperevm()` is a viem `Transport`. Pass it to `createPublicClient` the same way you pass `http()` or `fallback()`.
- **Tested.** The offline suite runs in CI. It does not call the public network.

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

> These are the commands a published release will use. `@bloxwap/hyperevm` is still private, so the registry 404s until a publish is approved. Clone this repository to use the source today. `github:bloxwap/hyperevm` resolves to the private workspace root, which does not export the transport. pnpm can select the library with `github:bloxwap/hyperevm#path:packages/hyperevm`.

## Release status

`0.1.0` is an early developer preview. The package stays private until a publish is approved. Expect breaking changes before `1.0`.

## Usage

### Read

```ts
import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { hyperevm } from "@bloxwap/hyperevm";

const client = createPublicClient({
  chain: hyperEvm,
  transport: hyperevm(),
});

const block = await client.getBlockNumber();
```

With no arguments, `hyperevm()` calls the eligible HTTP rows in [`packages/hyperevm/registry/nodes.json`](packages/hyperevm/registry/nodes.json). HyperEVM mainnet is chain id 999.

### Configure

```ts
import { http } from "viem";
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    http("https://rpc.hypurrscan.io", { batch: true }),
  ],
  hedge: { minDelay: 250, multiplier: 2 },
});
```

URL strings are wrapped in viem's `http()`, or `webSocket()` when the URL is `wss://`. A transport you pass in keeps the batching it was created with. Pass provider URLs as strings or `{ url, label }` rather than `http(url)`: viem drops the headers of a 429 or 503 whose body is a JSON-RPC error, so only a transport built from a URL keeps its `Retry-After`. Idempotent reads fail over on timeout, rate limit, and connection loss. Once every endpoint has failed a call, the transport backs off and tries again while `retryCount` allows. An endpoint that keeps failing is ejected for a cooldown.

`eth_sendRawTransaction` and `eth_sendRawTransactionSync` fail over on endpoint errors, because the same signed bytes have the same hash and the nonce stops a second execution. They are never hedged. The other non-idempotent methods go to one endpoint.

Before an endpoint serves its first call, the transport checks `eth_chainId` against the client chain (999 when there is none). An endpoint on another chain is quarantined and gets no calls.

### Production

Pass explicit endpoints you trust. The shipped registry currently rests on a single probe run, so every row in it is on the new-node cap. It is a reasonable default for scripts, not for a service.

```ts
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  endpoints: [
    { url: env.HYPERPC_URL, label: "hyperpc" }, // https://...?apikey=...
    { url: env.DRPC_URL, label: "drpc" }, // key in the path
    "https://rpc.hyperliquid.xyz/evm",
  ],
  timeout: 3_500,
  hedge: true,
});
```

- **Keys in URLs work at runtime.** An explicit endpoint may carry a key in its query, its path, or `user:pass@`. Events, `snapshot()`, `value.endpoints`, and thrown errors only show the `label`, or `scheme://host[:port]` when there is none. Do not commit those URLs. The registry still rejects them.
- **Build the transport once.** One `hyperevm()` factory shares a single instance (scores, breaker, probe timer) across every client built with the same timeout, retry count, and chain. Building it does no I/O and starts no timer. The head probe timer starts on the first request and stops after 60 seconds without one (`headLag.probeIdleTimeout`).
- **Cloudflare Workers.** Create the transport in module scope so each isolate builds it once, and create clients per request. Set `headLag: { probeInterval: false }` so nothing runs outside a request. Heads then come only from the `eth_blockNumber` and `latest` block reads your own calls make.
- **UI reads.** A per-attempt `timeout` of 3 to 4 seconds with `hedge: true` keeps a stalled node from holding a page. `options.timeout` wins over the client's `timeout`.
- **Shutdown.** `transport.value.close()` stops the probe timer. Later requests on every client sharing that instance reject with `TransportClosedError`. The next client built from the factory gets a fresh instance.

### Observe

```ts
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});
```

`onEvent` is telemetry. A throw inside the listener does not fail the request. Besides requests, successes, errors, failovers, and hedges, it reports `head` (with `trusted: false` when the head is ignored), `quarantine`, `eject`, and `restore`. `transport.value.snapshot(method)` returns the current scores for `method` (default `eth_call`), heads, lag, quarantine, and in-flight counts. The score, the registry window, and the anti-gaming rules are in [docs/ranking.md](docs/ranking.md).

## Documentation

The ranking write-up is [docs/ranking.md](docs/ranking.md). Submitting a public endpoint is [CONTRIBUTING.md](CONTRIBUTING.md).

A Fumadocs site is not part of this repository yet. The package reference lives on [`packages/hyperevm`](packages/hyperevm/README.md), and the public types are documented in JSDoc on `src/mod.ts`.

## Development

This repository is a Bun workspace with one install and one root `bun.lock`:

| Workspace | Purpose |
| --- | --- |
| [`packages/hyperevm`](packages/hyperevm/README.md) | `@bloxwap/hyperevm` transport, registry, tests, and package tooling |

The root package is private and coordinates development. The library builds to `packages/hyperevm/dist`. Exports point at TypeScript sources. Nothing in this repository is published to npm.

Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Type-checking uses `tsc --noEmit`. `bun run rank` probes the public lists and rewrites the registry. It does not push to `main`.

## Security

**Registry rows and examples are public URLs.** Do not commit an RPC URL that contains an API key, username, or password. The ranker rejects credentials and query strings. Load a private endpoint from the environment. Bun reads a local `.env`, and this repository gitignores it.

At runtime, `hyperevm()` accepts key-bearing URLs and exposes only a public label. Errors from those endpoints have every spelling of the URL replaced by the label, at any depth, response headers included. A provider that echoes the bare key on its own in an error body is not scrubbed.

This package routes JSON-RPC. It does not sign transactions or hold a wallet.

## License

[MIT](LICENSE)
