/**
 * Offline ranking for the public registry.
 *
 * Runtime routing in {@link endpointScore} reacts to the call in flight. This
 * module decides which endpoints are allowed into that pool, and at what
 * weight, from a rolling window of probe observations. A new URL cannot take
 * full weight until it has stayed up across the window, and the new URLs
 * together cannot crowd out endpoints that already earned full weight.
 * @module
 */

/** Where a registry URL was found. */
export interface RegistrySource {
  name: string;
  url: string;
}

export type Tracking = "none" | "limited" | "yes" | "unknown";

export type EndpointKind = "http" | "websocket";

export type Submission = "upstream" | "community";

/** One probe of one URL. `lag` is blocks behind the best head in that probe run. */
export interface ProbeObservation {
  at: string;
  url: string;
  ok: boolean;
  chainIdOk: boolean;
  head: number | null;
  lag: number | null;
  /** When `eth_blockNumber` returned. Lag adjustment uses this so an earlier probe is not punished for blocks mined while it waited. */
  headAt?: string | undefined;
  methods: Record<string, { ms: number; ok: boolean }>;
}

/**
 * `methods` key for an `eth_call` to the HyperCore L1 block number read precompile.
 * Observations written before this probe existed lack the key and are not punished for it.
 */
export const PRECOMPILE_PROBE = "hypercore_l1BlockNumber";

/** `methods` key for an `eth_getLogs` over a 999-block range ending at the probed head. */
export const LOGS_RANGE_PROBE = "eth_getLogs_range";

/** Width of the {@link LOGS_RANGE_PROBE} query: one page for a client that stays under a 1,000-block provider cap. */
export const LOGS_RANGE_BLOCKS = 999;

/** An endpoint before rank, weight, and stats are filled in. */
export interface RegistryEndpointInput {
  url: string;
  kind: EndpointKind;
  tracking: Tracking;
  sources: RegistrySource[];
  submission: Submission;
  addedAt: string;
}

/** Probe summary stored next to the endpoint so a reader can see why it ranked there. */
export interface RegistryEndpointStats {
  observations: number;
  successes: number;
  uptime: number;
  latencyMs: number | null;
  tailMs: number | null;
  medianLag: number | null;
  established: boolean;
  /** Latest {@link PRECOMPILE_PROBE} result in the window. `null` when no probe recorded it. */
  precompileOk?: boolean | null | undefined;
}

/** One row of `registry/nodes.json`. */
export interface RegistryEndpoint extends RegistryEndpointInput {
  eligible: boolean;
  weight: number;
  rank: number | null;
  stats: RegistryEndpointStats | null;
}

/** Knobs written into the registry and read back by the ranker. */
export interface RankPolicy {
  /** Drop observations older than this many milliseconds. */
  windowMs: number;
  /** Successful probes required before an endpoint leaves the new-node cap. */
  minObservations: number;
  /** First and last observation in the window must be at least this far apart. */
  minSpanMs: number;
  /** Success rate required for full weight. */
  minUptime: number;
  /** Uptime below this excludes the endpoint from the default pool. */
  minEligibleUptime: number;
  /** Weight ceiling for an endpoint that is not yet established. */
  newNodeWeightCap: number;
  /** Share of total weight that non-established endpoints may hold, once any endpoint is established. */
  maxNewNodeShare: number;
}

/** Four weekly probes fit in the window. Full weight needs three of them spread over two weeks. */
export const defaultRankPolicy: RankPolicy = {
  windowMs: 28 * 24 * 60 * 60 * 1000,
  minObservations: 3,
  minSpanMs: 14 * 24 * 60 * 60 * 1000,
  minUptime: 0.8,
  minEligibleUptime: 0.5,
  newNodeWeightCap: 0.15,
  maxNewNodeShare: 0.25,
};

const TRACKING_RANK: Record<Tracking, number> = {
  unknown: 0,
  none: 1,
  limited: 2,
  yes: 3,
};

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (sorted.length % 2 === 0 && left !== undefined && right !== undefined) return (left + right) / 2;
  return right ?? null;
}

function sourceKey(source: RegistrySource): string {
  return `${source.name} ${source.url}`;
}

function mergeSources(left: readonly RegistrySource[], right: readonly RegistrySource[]): RegistrySource[] {
  const merged: RegistrySource[] = [];
  const seen = new Set<string>();
  for (const source of [...left, ...right]) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ name: source.name, url: source.url });
  }
  return merged;
}

function stricterTracking(left: Tracking, right: Tracking): Tracking {
  return TRACKING_RANK[left] >= TRACKING_RANK[right] ? left : right;
}

/**
 * Union upstream fetches with the previous registry.
 * Community submissions stay even when the upstream lists no longer mention them.
 * Upstream URLs that disappeared are dropped.
 */
export function mergeEndpointInputs(
  fetched: readonly RegistryEndpointInput[],
  previous: readonly RegistryEndpointInput[],
  nowIso: string,
): RegistryEndpointInput[] {
  const byUrl = new Map<string, RegistryEndpointInput>();
  for (const endpoint of previous) {
    if (endpoint.submission !== "community") continue;
    byUrl.set(endpoint.url, {
      ...endpoint,
      sources: endpoint.sources.map((source) => ({ ...source })),
    });
  }
  for (const endpoint of fetched) {
    const existing = byUrl.get(endpoint.url) ?? previous.find((item) => item.url === endpoint.url);
    if (!existing) {
      byUrl.set(endpoint.url, {
        ...endpoint,
        sources: endpoint.sources.map((source) => ({ ...source })),
        addedAt: endpoint.addedAt || nowIso,
      });
      continue;
    }
    byUrl.set(endpoint.url, {
      url: endpoint.url,
      kind: endpoint.kind,
      tracking: stricterTracking(existing.tracking, endpoint.tracking),
      sources: mergeSources(existing.sources, endpoint.sources),
      submission: existing.submission === "community" ? "community" : endpoint.submission,
      addedAt: existing.addedAt || endpoint.addedAt || nowIso,
    });
  }
  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}

interface ScoredRow {
  endpoint: RegistryEndpoint;
  score: number;
}

function methodMedians(observations: readonly ProbeObservation[]): { typical: number | null; tail: number | null } {
  const byMethod = new Map<string, number[]>();
  const samples: number[] = [];
  for (const observation of observations) {
    if (!observation.ok || !observation.chainIdOk) continue;
    for (const [method, sample] of Object.entries(observation.methods)) {
      if (!sample.ok) continue;
      const list = byMethod.get(method) ?? [];
      list.push(sample.ms);
      byMethod.set(method, list);
      samples.push(sample.ms);
    }
  }
  const medians: number[] = [];
  for (const list of byMethod.values()) {
    const value = median(list);
    if (value !== null) medians.push(value);
  }
  return {
    typical: medians.length === 0 ? null : Math.max(...medians),
    tail: samples.length === 0 ? null : Math.max(...samples),
  };
}

/** A missing key is an older observation, not a failure. */
function probePassed(observation: ProbeObservation, method: string): boolean {
  return observation.methods[method]?.ok !== false;
}

/** Up on chain 999 and, where recorded, able to serve a 999-block `eth_getLogs` and a HyperCore read. */
function isSuccess(observation: ProbeObservation): boolean {
  return (
    observation.ok &&
    observation.chainIdOk &&
    probePassed(observation, LOGS_RANGE_PROBE) &&
    probePassed(observation, PRECOMPILE_PROBE)
  );
}

/**
 * Latest precompile result from an observation that was otherwise up.
 * A down node is uptime's concern; this asks only whether a live node serves HyperCore reads.
 */
function latestPrecompile(observations: readonly ProbeObservation[]): boolean | null {
  let latestAt = Number.NEGATIVE_INFINITY;
  let latest: boolean | null = null;
  for (const observation of observations) {
    const sample = observation.methods[PRECOMPILE_PROBE];
    if (sample === undefined || !observation.ok || !observation.chainIdOk) continue;
    const at = Date.parse(observation.at);
    if (!Number.isFinite(at) || at < latestAt) continue;
    latestAt = at;
    latest = sample.ok;
  }
  return latest;
}

/** Same grace the transport uses. A block or two is probe skew, not a stale node. */
const LAG_GRACE_BLOCKS = 2;

function scoreRow(stats: RegistryEndpointStats): number {
  const typical = stats.latencyMs ?? Number.POSITIVE_INFINITY;
  const tail = stats.tailMs ?? typical;
  const latency = 0.6 * typical + 0.4 * tail;
  const lag = stats.medianLag ?? 0;
  const lagPenalty = 1 + Math.max(0, lag - LAG_GRACE_BLOCKS);
  const uptime = stats.uptime;
  return latency * lagPenalty * (1 + (1 - uptime) * 4);
}

function applyShareCap(rows: RegistryEndpoint[], policy: RankPolicy): void {
  const established = rows.filter((row) => row.eligible && row.stats?.established === true);
  const fresh = rows.filter((row) => row.eligible && row.stats?.established !== true);
  const oldWeight = established.reduce((sum, row) => sum + row.weight, 0);
  const newWeight = fresh.reduce((sum, row) => sum + row.weight, 0);
  if (oldWeight <= 0 || newWeight <= 0) return;
  const share = newWeight / (oldWeight + newWeight);
  if (share <= policy.maxNewNodeShare) return;
  const allowed = (policy.maxNewNodeShare / (1 - policy.maxNewNodeShare)) * oldWeight;
  const scale = allowed / newWeight;
  for (const row of fresh) {
    row.weight = round(row.weight * scale, 4);
  }
}

/**
 * Rank `endpoints` from `observations`. WebSocket URLs stay listed and are
 * excluded from the HTTP pool. HTTP URLs with no successful probe in the
 * window stay listed at weight 0. A failed 999-block `eth_getLogs` or
 * HyperCore read counts as a missed probe, and an endpoint whose latest
 * HyperCore read failed is excluded from the default pool.
 */
export function rankRegistry(
  endpoints: readonly RegistryEndpointInput[],
  observations: readonly ProbeObservation[],
  nowMs: number,
  policy: RankPolicy = defaultRankPolicy,
): RegistryEndpoint[] {
  const freshObservations = observations.filter((observation) => {
    const at = Date.parse(observation.at);
    return Number.isFinite(at) && nowMs - at <= policy.windowMs && nowMs - at >= 0;
  });

  const rows: ScoredRow[] = endpoints.map((endpoint) => {
    if (endpoint.kind !== "http") {
      return {
        score: Number.POSITIVE_INFINITY,
        endpoint: { ...endpoint, eligible: false, weight: 0, rank: null, stats: null },
      };
    }
    const mine = freshObservations.filter((observation) => observation.url === endpoint.url);
    const successes = mine.filter(isSuccess);
    const uptime = mine.length === 0 ? 0 : successes.length / mine.length;
    const times = mine.map((observation) => Date.parse(observation.at)).filter((at) => Number.isFinite(at));
    times.sort((a, b) => a - b);
    const first = times[0];
    const last = times[times.length - 1];
    const span = first !== undefined && last !== undefined ? last - first : 0;
    const { typical, tail } = methodMedians(mine);
    const lags = mine.map((observation) => observation.lag).filter((lag): lag is number => lag !== null);
    const established =
      successes.length >= policy.minObservations && span >= policy.minSpanMs && uptime >= policy.minUptime;
    const precompileOk = latestPrecompile(mine);
    const eligible =
      successes.length > 0 && uptime >= policy.minEligibleUptime && typical !== null && precompileOk !== false;
    const stats: RegistryEndpointStats = {
      observations: mine.length,
      successes: successes.length,
      uptime: round(uptime, 4),
      latencyMs: typical === null ? null : round(typical, 1),
      tailMs: tail === null ? null : round(tail, 1),
      medianLag: median(lags) === null ? null : round(median(lags) ?? 0, 2),
      established,
      precompileOk,
    };
    const weight = !eligible ? 0 : established ? 1 : policy.newNodeWeightCap;
    return {
      score: eligible ? scoreRow(stats) : Number.POSITIVE_INFINITY,
      endpoint: {
        ...endpoint,
        eligible,
        weight,
        rank: null,
        stats,
      },
    };
  });

  const eligible = rows
    .filter((row) => row.endpoint.eligible)
    .sort((a, b) => a.score - b.score || a.endpoint.url.localeCompare(b.endpoint.url));
  eligible.forEach((row, index) => {
    row.endpoint.rank = index + 1;
  });
  applyShareCap(
    rows.map((row) => row.endpoint),
    policy,
  );

  return rows
    .map((row) => row.endpoint)
    .sort((a, b) => {
      if (a.rank === null && b.rank === null) return a.url.localeCompare(b.url);
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    });
}

/**
 * Why `next` must not replace `previous`, or undefined when it may.
 * A run can pass every chain and head check and still leave no endpoint eligible, for example when each
 * HyperCore read probe fails at once. Writing that registry would make the default transport throw.
 */
export function refuseRegistryRewrite(
  previous: readonly RegistryEndpoint[],
  next: readonly RegistryEndpoint[],
): string | undefined {
  if (!previous.some((endpoint) => endpoint.eligible)) return undefined;
  if (next.some((endpoint) => endpoint.eligible)) return undefined;
  return "Ranking left no endpoint eligible. Refusing to replace a registry that had eligible endpoints.";
}
