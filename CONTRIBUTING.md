# Contributing

Issues and small fixes are welcome. Please open an issue before starting a large change.

`@bloxwap/smart-hyperevm` is published to npm. A release needs Joe's approval: bump `version` in `packages/smart-hyperevm/package.json`, then run `npm publish` from `packages/smart-hyperevm`. `prepublishOnly` typechecks, tests, and builds `dist/` (ESM bundles plus declarations) first. Tag the release commit `vX.Y.Z`.

## Development

Requires [Bun](https://bun.sh) and Node.js 22.12 or newer (Bun is what the scripts and tests use).

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

`bun run check` is format, lint, and typecheck. Tests use `bun test`. They do not call the public network.

## Submitting a public RPC endpoint

The default transport reads [`packages/smart-hyperevm/registry/nodes.json`](packages/smart-hyperevm/registry/nodes.json). Add a node by pull request. The weekly rank workflow probes what you added and opens a follow-up PR with weights. It does not push to `main`.

One endpoint per pull request is easiest to review.

1. Confirm the endpoint is public. No API key, no username or password, no query string. `https://` or `wss://` only. It must answer `eth_chainId` with `0x3e7` (decimal 999). HyperEVM testnet is chain id 998 and does not belong in this file.
2. Do not add the Wanchain Testnet URL. ethereum-lists `eip155-999.json` is Wanchain, not HyperEVM, even though the chain id collides.
3. Add an object to `endpoints`:

```json
{
  "url": "https://rpc.example/evm",
  "kind": "http",
  "tracking": "unknown",
  "sources": [{ "name": "community", "url": "https://example.com/where-you-saw-it" }],
  "submission": "community",
  "addedAt": "2026-10-30T00:00:00.000Z",
  "eligible": false,
  "weight": 0,
  "rank": null,
  "stats": null
}
```

`sources[0].url` should be a page that lists this endpoint, not a private dashboard. Set `tracking` to `none`, `limited`, or `yes` when the operator says whether they log requests. Use `unknown` when you do not know.

4. Leave `eligible`, `weight`, `rank`, and `stats` as above. Do not copy a weight from another row. The ranker is the only writer of those fields. A new URL stays on the new-node cap (weight 0.15) until it has at least three successful probes spread across 14 days, with uptime of at least 0.8. Until then it is usable, but it cannot take the pool. See [Routing and caching](apps/docs/content/docs/routing.md).
5. Run `bun run test` so the file still matches the schema checks.

Community rows are kept when upstream lists forget them. An upstream row that disappears from every source is removed on the next successful rank run.

## What the rank workflow will not do

- It will not promote a node because it was fast once.
- It will not give a pile of new URLs more than 25% of the total weight while an established node exists.
- It will not accept a URL that returns a chain id other than 999.
- It will not open a pull request that empties a registry which already had eligible endpoints, if the probe run could not reach any of them.
