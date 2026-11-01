# Tests

Test suite for the transport, run with `bun test`.

## Layout

| Directory          | Covers                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `tests/transport/` | The viem transport: routing, failover, hedging, head lag, batches, scores, and method policy. |
| `tests/registry/`  | The shipped registry, URL checks, rank policy, probe lag assignment, and source parsers.      |
| `tests/bench/`     | The offline simulation against viem `fallback`.                                               |

## Running

Run these commands from `packages/hyperevm/`. The workspace root also provides `bun run test`.

```sh
bun test tests/
```

`test` in `package.json` is the same invocation. The suite is offline. It does not call a public endpoint.

## Conventions

Files that cover an internal module use the same `_` prefix as that module (`tests/transport/_score.test.ts` for `src/transport/_score.ts`). The public entry of a folder is `mod.test.ts`.
