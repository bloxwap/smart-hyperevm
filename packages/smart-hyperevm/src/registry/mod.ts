/**
 * Public HyperEVM registry: the shipped endpoint list, the ranker types, and URL checks.
 *
 * @module
 */

export {
  defaultRankPolicy,
  mergeEndpointInputs,
  rankRegistry,
  type EndpointKind,
  type ProbeObservation,
  type RankPolicy,
  type RegistryEndpoint,
  type RegistryEndpointInput,
  type RegistryEndpointStats,
  type RegistrySource,
  type Submission,
  type Tracking,
} from "./_policy.ts";
export {
  assertRegistryFile,
  defaultRegistry,
  registryHttpEndpoints,
  registryPolicy,
  type RegistryFile,
} from "./_registry.ts";
export { isWanchainHost, normalizeRpcUrl, type NormalizedRpcUrl } from "./_url.ts";

/** HyperEVM mainnet chain id. The registry is this chain and no other. */
export const HYPEREVM_CHAIN_ID = 999;
