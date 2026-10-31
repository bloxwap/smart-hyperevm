/**
 * Latency-aware JSON-RPC transport for HyperEVM.
 *
 * The main entrypoint exports {@link hyperevm}, the errors it raises, and the
 * shipped registry helpers.
 *
 * Tree-shakeable imports:
 * - `@bloxwap/hyperevm/transport`
 * - `@bloxwap/hyperevm/registry`
 *
 * @example Quick start
 * ```ts
 * import { createPublicClient } from "viem";
 * import { hyperEvm } from "viem/chains";
 * import { hyperevm } from "@bloxwap/hyperevm";
 *
 * const client = createPublicClient({
 *   chain: hyperEvm,
 *   transport: hyperevm(),
 * });
 * ```
 *
 * @module
 */

export { AllEndpointsFailedError, ChainMismatchError, TimeoutError, TransportClosedError } from "./_errors.ts";
export {
  HYPEREVM_CHAIN_ID,
  assertRegistryFile,
  defaultRankPolicy,
  defaultRegistry,
  isWanchainHost,
  mergeEndpointInputs,
  normalizeRpcUrl,
  rankRegistry,
  registryHttpEndpoints,
  registryPolicy,
  type EndpointKind,
  type NormalizedRpcUrl,
  type ProbeObservation,
  type RankPolicy,
  type RegistryEndpoint,
  type RegistryEndpointInput,
  type RegistryEndpointStats,
  type RegistryFile,
  type RegistrySource,
  type Submission,
  type Tracking,
} from "./registry/mod.ts";
export {
  NON_IDEMPOTENT_METHODS,
  REBROADCAST_METHODS,
  blockNumberFromResult,
  defaultScoreConfig,
  endpointScore,
  hyperevm,
  inflation,
  isIdempotentMethod,
  isRebroadcastMethod,
  parseQuantity,
  shouldFailover,
  type BatchOptions,
  type BreakerOptions,
  type EndpointSnapshot,
  type HeadLagOptions,
  type HedgeOptions,
  type HyperevmEndpoint,
  type HyperevmEndpointConfig,
  type HyperevmEvent,
  type HyperevmTransportOptions,
  type HyperevmTransportValue,
  type MethodStat,
  type ScoreConfig,
} from "./transport/mod.ts";
