---

title: Get started
description: Install and use the Bloxwap HyperEVM RPC transport with viem.
---

# HyperEVM RPC

`@bloxwap/hyperevm` is a drop-in viem transport for HyperEVM. It ranks RPC endpoints using live latency, errors, congestion, and block-head lag, then races the best candidates. Recent reads can be answered from a local cache.

## Install

```sh
bun add @bloxwap/hyperevm
```

npm, pnpm, and Yarn work too. Node.js 22.12 or later is required. `viem` is the only peer dependency; the package has no runtime dependencies of its own.

## Create a client

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

With no arguments, `hyperevm()` uses the eligible HTTP endpoints in the shipped registry. HyperEVM mainnet is chain ID 999.

## Defaults

| Feature         | Default behavior                                                    |
| --------------- | ------------------------------------------------------------------- |
| Racing          | Sends idempotent reads to the two best-scored endpoints.            |
| Failover        | Retries endpoint errors and ejects repeatedly failing endpoints.    |
| Pinned latest   | Uses one consistent block across endpoints.                         |
| Coalescing      | Shares identical in-flight reads.                                   |
| Cache           | Serves recent reads at most one block behind the newest known head. |
| Log index       | Maintains a rolling 1,000-block window for recent filters.          |
| Background work | Refreshes hot keys and pauses in hidden browser tabs.               |

These defaults trade additional upstream requests for lower latency and better availability. Disable individual features when request cost or freshness matters more.

## Next steps

- [Configure endpoints and production runtimes](configuration.md)
- [Understand routing, caching, and registry ranking](routing.md)
- [Review the benchmark methodology](benchmarks.md)
- [Inspect telemetry, errors, and safety behavior](api.md)
