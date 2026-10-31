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

export {
  AllEndpointsFailedError,
  BudgetExhaustedError,
  ChainMismatchError,
  TimeoutError,
  TransportClosedError,
} from "./_errors.ts";
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
  localStoragePersistence,
  parseQuantity,
  shouldFailover,
  type BatchOptions,
  type BreakerOptions,
  type BudgetOptions,
  type CacheOptions,
  type CacheStats,
  type EndpointSnapshot,
  type HeadLagOptions,
  type HedgeOptions,
  type HyperevmEndpoint,
  type HyperevmEndpointConfig,
  type HyperevmEvent,
  type HyperevmTransportOptions,
  type HyperevmTransportValue,
  type MethodStat,
  type PinLatestOptions,
  type RaceOptions,
  type ScoreBook,
  type ScoreConfig,
  type ScorePersistence,
  type ScoreSnapshot,
} from "./transport/mod.ts";
