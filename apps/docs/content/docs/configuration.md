---

title: Configuration
description: Configure HyperEVM endpoints, request budgets, caching, and production runtimes.
---

# Configuration

## Endpoints

Pass public URLs, keyed provider URLs, or existing viem transports:

```ts
import { http } from "viem";
import { smartHyperevm } from "@bloxwap/smart-hyperevm";

const transport = smartHyperevm({
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    { url: env.HYPERPC_URL, label: "hyperpc", rps: 10 },
    http("https://rpc.hypurrscan.io", { batch: true }),
  ],
  timeout: 3_500,
  hedge: true,
});
```

URL strings use viem `http()`, or `webSocket()` for `wss://` URLs. Prefer strings or `{ url, label }` for keyed providers so the transport can preserve rate-limit headers and redact credentials. Labels appear in telemetry instead of private URLs.

The transport verifies `eth_chainId` before using an endpoint. A node on another chain is quarantined.

## Common options

| Option                     | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `timeout`                  | Per-attempt deadline in milliseconds.                         |
| `retryCount`, `retryDelay` | Failover attempts and backoff.                                |
| `race`                     | Parallel read width; set `false` for one initial endpoint.    |
| `hedge`                    | Copies slow reads to a backup after a delay. Off by default.  |
| `pinLatest`                | Pins reads to a block the selected endpoints hold.            |
| `coalesce`                 | Shares identical in-flight reads.                             |
| `cache`                    | Bounds staleness, memory, hot keys, and background refreshes. |
| `budget`                   | Default request token bucket for endpoints.                   |
| `headLag`                  | Probe frequency, lag limits, and idle behavior.               |
| `persist`                  | Restores endpoint scores from previous sessions.              |
| `isActive`                 | Pauses background work in hidden tabs or inactive apps.       |

See [Routing and caching](routing.md) for every default and the interactions between these options.

## Production

Create one factory per process or Worker isolate and share it across clients. Use explicit endpoints you trust in services.

```ts
const transport = smartHyperevm({
  endpoints: [
    { url: env.HYPERPC_URL, label: "hyperpc" },
    { url: env.DRPC_URL, label: "drpc" },
    "https://rpc.hyperliquid.xyz/evm",
  ],
  timeout: 3_500,
});
```

On Cloudflare Workers, disable timers outside requests:

```ts
const transport = smartHyperevm({
  headLag: { probeInterval: false },
});
```

Background cache refreshes end with a Worker invocation. Cached entries then expire according to `maxAgeMs`.

## Freshness and request cost

Cached answers may be one block behind by default. A scanner that advances through every block should require the current head:

```ts
const transport = smartHyperevm({
  cache: { maxStaleBlocks: 0 },
});
```

Racing and background refreshes increase upstream traffic. For a shared server IP, consider `race: false`, a longer `refreshInterval`, fewer hot keys, or viem HTTP batching. Endpoint `rps` and `burst` values keep requests within provider budgets.

## Shutdown

```ts
transport.value.close();
```

This stops timers, removes browser listeners, and saves persisted scores. Later requests through the closed instance fail; calls already in flight finish.
